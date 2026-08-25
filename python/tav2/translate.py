"""翻译执行器：顺序主线 + 分支记忆轨道 + 双阶段协议 + 门禁 + 回填。"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Any

from tav2.adapters.base import EngineAdapter
from tav2.config import resolve_project_dir
from tav2.llm import BaseLLM, LLMError, extract_json
from tav2.memory import build_memory_pack
from tav2.models import Scene
from tav2.prompts import POLISH_PROMPT, render
from tav2.rewrite import rewrite_scene
from tav2.summary import update_summary
from tav2.terms import queue_rolling_flags
from tav2.understanding import generate_understanding
from tav2.tokens import estimate_tokens


# 每个单元的基础开销：提示词中的标识符行、边界与格式损耗
_UNIT_OVERHEAD = 20


def _md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


class BatchSizer:
    """动态批大小状态机：连续失败收缩、连续成功放大，带上下限。"""

    def __init__(self, cfg: dict[str, Any]) -> None:
        ctx = cfg.get("context") or {}
        self.adaptive = bool(ctx.get("adaptive_batch", False))
        self.max_units = int(ctx.get("scene_max_units", 40) or 40)
        self.max_tokens = int(ctx.get("max_tokens", 6000) or 6000)
        self.min_units = max(1, int(ctx.get("adaptive_min_units", 10) or 10))
        self.min_tokens = max(1, int(ctx.get("adaptive_min_tokens", 1500) or 1500))
        self.max_units_cap = max(self.min_units, int(ctx.get("adaptive_max_units", 80) or 80))
        self.max_tokens_cap = max(self.min_tokens, int(ctx.get("adaptive_max_tokens", 12000) or 12000))
        self.shrink = float(ctx.get("adaptive_shrink", 0.5) or 0.5)
        self.grow = float(ctx.get("adaptive_grow", 1.5) or 1.5)
        self.fail_threshold = max(1, int(ctx.get("adaptive_fail_threshold", 2) or 2))
        self.success_threshold = max(1, int(ctx.get("adaptive_success_threshold", 3) or 3))
        self._consec_fail = 0
        self._consec_success = 0
        self.shrunk = 0
        self.grown = 0

    def params(self) -> tuple[int, int]:
        return self.max_units, self.max_tokens

    def record(self, record: dict[str, Any]) -> None:
        """按单个子批结果更新连续成功/失败计数并调整批大小。"""

        if not self.adaptive:
            return
        source_units = int(record.get("source_units") or 0)
        failed = bool(record.get("retries") or 0) or int(
            record.get("translated") or 0
        ) < source_units
        if failed:
            self._consec_fail += 1
            self._consec_success = 0
            if self._consec_fail >= self.fail_threshold:
                self._consec_fail = 0
                self.max_units = max(self.min_units, int(self.max_units * self.shrink))
                self.max_tokens = max(self.min_tokens, int(self.max_tokens * self.shrink))
                self.shrunk += 1
        else:
            self._consec_success += 1
            self._consec_fail = 0
            if self._consec_success >= self.success_threshold:
                self._consec_success = 0
                self.max_units = min(self.max_units_cap, int(self.max_units * self.grow))
                self.max_tokens = min(self.max_tokens_cap, int(self.max_tokens * self.grow))
                self.grown += 1

    def summary(self) -> dict[str, Any]:
        return {
            "adaptive": self.adaptive,
            "max_units": self.max_units,
            "max_tokens": self.max_tokens,
            "min_units": self.min_units,
            "max_units_cap": self.max_units_cap,
            "shrunk": self.shrunk,
            "grown": self.grown,
        }


def split_units(
    units: list[Any],
    max_units: int = 15,
    max_tokens: int = 3000,
) -> list[list[Any]]:
    """把已排序的单元按条数/token 预算切分为子批（保持原始顺序）。

    单条文本本身超预算时也自成一批，不丢弃。
    """

    max_units = max(int(max_units or 0), 1)
    max_tokens = max(int(max_tokens or 0), 1)
    batches: list[list[Any]] = []
    current: list[Any] = []
    token_sum = 0
    for unit in units:
        cost = estimate_tokens(unit.source) + _UNIT_OVERHEAD
        if current and (len(current) >= max_units or token_sum + cost > max_tokens):
            batches.append(current)
            current = []
            token_sum = 0
        current.append(unit)
        token_sum += cost
    if current:
        batches.append(current)
    return batches


def merge_string_scenes(document: Any) -> Any:
    """把纯字符串场景合并为一个全局字符串场景。

    菜单/UI 字符串无剧情上下文，全局聚合可减少调用次数并利于术语一致；
    对话/旁白场景保持原样。
    """

    string_scenes = [
        s for s in document.scenes if s.units and all(u.kind == "string" for u in s.units)
    ]
    if len(string_scenes) <= 1:
        return document.scenes
    merged = type(string_scenes[0])(
        scene_id="strings",
        title="strings",
        order=document.scenes.index(string_scenes[0]),
        branch="main",
    )
    units: list[Any] = []
    for scene in string_scenes:
        units.extend(scene.units)
    units.sort(key=lambda u: (str(u.extra.get("file") or ""), str(u.source)))
    for unit in units:
        unit.scene_id = "strings"
    merged.units = units
    remaining = [s for s in document.scenes if s not in string_scenes]
    document.scenes = remaining + [merged]
    for idx, scene in enumerate(document.scenes):
        scene.order = idx
    return merged


def unit_context_fp(unit: Any, scene: Any) -> str:
    """单元上下文指纹：对话 = md5(file|label|speaker|前2|后2)；字符串 = md5(file)。"""

    file_ = str(unit.extra.get("file") or "")
    if unit.kind == "string":
        return _md5(file_)
    label = scene.scene_id.split("::", 1)[1] if "::" in scene.scene_id else scene.scene_id
    idx = next((i for i, u in enumerate(scene.units) if u.unit_id == unit.unit_id), -1)
    prev = " | ".join(u.source for u in scene.units[max(0, idx - 2) : idx])
    nxt = " | ".join(u.source for u in scene.units[idx + 1 : idx + 3])
    return _md5(f"{file_}|{label}|{unit.speaker}|{prev}|{nxt}")


def _match_reusable(document: Any, db: Any) -> tuple[dict[str, str], int]:
    """扫描文档中可被 TM 直接复用的待译单元（同源+同上下文指纹）。"""

    translations: dict[str, str] = {}
    src_tokens = 0
    for scene in document.scenes:
        for unit in scene.units:
            if unit.extra.get("translated", False):
                continue
            fp = unit_context_fp(unit, scene)
            text = db.tm_get(unit.source, fp)
            if text and text != unit.source:
                translations[unit.unit_id] = text
                src_tokens += estimate_tokens(unit.source)
    return translations, src_tokens


def preview_reuse(cfg: dict[str, Any], adapter: Any, db: Any) -> dict[str, Any]:
    """reuse 工具 dry-run：返回可复用行数与预估节省 token。"""

    doc = adapter.extract()
    merge_string_scenes(doc)
    translations, src_tokens = _match_reusable(doc, db)
    return {
        "reusable": len(translations),
        "saved_prompt_tokens_est": src_tokens,
        "saved_completion_tokens_est": int(src_tokens * 1.3),
    }


def apply_reuse(cfg: dict[str, Any], adapter: Any, db: Any) -> dict[str, Any]:
    """reuse 工具 apply：预回填同源同指纹译文（不调 LLM），返回应用行数。"""

    doc = adapter.extract()
    merge_string_scenes(doc)
    translations, src_tokens = _match_reusable(doc, db)
    if not translations:
        return {
            "applied": 0,
            "saved_prompt_tokens_est": 0,
            "saved_completion_tokens_est": 0,
        }
    db.sync_units(doc)
    adapter.backfill(translations)
    for unit_id in translations:
        db.set_unit_status(unit_id, "translated")
    return {
        "applied": len(translations),
        "saved_prompt_tokens_est": src_tokens,
        "saved_completion_tokens_est": int(src_tokens * 1.3),
    }


def plan_batches(cfg: dict[str, Any], adapter: Any) -> dict[str, Any]:
    """plan-batches 工具：按当前批大小策略预览子批数/调用预估。"""

    doc = adapter.extract()
    merge_string_scenes(doc)
    sizer = BatchSizer(cfg)
    max_units, max_tokens = sizer.params()
    scenes = [s for s in doc.scenes if s.units]
    pending_units = 0
    total_subs = 0
    understanding = 0
    for scene in scenes:
        pending = [u for u in scene.units if not u.extra.get("translated", False)]
        pending_units += len(pending)
        total_subs += len(split_units(pending, max_units, max_tokens))
        if any(u.kind != "string" for u in pending):
            understanding += 1
    return {
        "scenes": len(scenes),
        "pending_units": pending_units,
        "sub_batches_est": total_subs,
        "understanding_calls_est": understanding,
        "calls_est": total_subs + understanding,
        "max_units": max_units,
        "max_tokens": max_tokens,
        "adaptive": sizer.adaptive,
    }


class TranslateRunner:
    """按文档场景顺序执行双阶段翻译。"""

    def __init__(self, cfg: dict[str, Any], adapter: EngineAdapter, db: Any, llm: BaseLLM):
        self.cfg = cfg
        self.adapter = adapter
        self.db = db
        self.llm = llm
        self._db_lock = Lock()
        self._stats_lock = Lock()
        self._all_translations: dict[str, str] = {}
        self.batch_sizer = BatchSizer(cfg)
        self._budget = 0

    def run(
        self,
        limit: int | None = None,
        dry_run: bool = False,
        batch_mode: str = "",
        budget: int = 0,
    ) -> dict[str, Any]:
        if batch_mode == "auto":
            self.cfg.setdefault("context", {})["adaptive_batch"] = True
            self.batch_sizer = BatchSizer(self.cfg)
        if budget:
            self._budget = max(0, int(budget))
        else:
            self._budget = max(
                0, int(self.cfg.get("context", {}).get("budget_tokens", 0) or 0)
            )
        document = self.adapter.extract()
        merge_string_scenes(document)
        reused_units = 0
        if not dry_run:
            reused_units = self._prefill_reuse(document)
            if reused_units:
                # 预回填后重新抽取，让已复用单元从待译队列中正确剔除
                document = self.adapter.extract()
                merge_string_scenes(document)
        self.db.sync_units(document)
        scenes = [s for s in document.scenes if s.units]
        if limit is not None:
            scenes = scenes[:limit]

        pending_scenes = [s for s in scenes if self._scene_pending(s)]
        run_id = uuid.uuid4().hex[:12]
        self.db.begin_run(run_id, "translate")
        summary_stats: dict[str, Any] = {
            "run_id": run_id,
            "scenes_total": len(scenes),
            "scenes_done": 0,
            "units_total": sum(len(s.units) for s in scenes),
            "units_translated": 0,
            "retry_rounds": 0,
            "term_misses": 0,
            "banned_hits": 0,
            "approvals_queued": 0,
            "branch_tracks": 0,
            "sub_batches_total": 0,
            "sub_batches_done": 0,
            "sub_batch_records": [],
            "reused_units": reused_units,
        }
        try:
            tracks = self._build_tracks(pending_scenes)
            self._main_branch = tracks[0][0].branch if tracks else "main"
            summary_stats["branch_tracks"] = len(tracks)
            self._run_tracks(tracks, dry_run, summary_stats)
            if not dry_run and not self.cfg.get("review", {}).get("enabled", False):
                self.db.set_meta("last_translate_run", run_id)
            if not dry_run and self.cfg.get("review", {}).get("enabled", False):
                from tav2.review import write_review_sheet

                project_dir = resolve_project_dir(self.cfg, self.adapter.game_dir)
                review_path = write_review_sheet(project_dir, document, self._all_translations)
                self.db.set_meta("last_review_sheet", str(review_path))
                summary_stats["review_sheet"] = str(review_path)
            usage = self.llm.usage_snapshot()
            self.db.add_usage(
                run_id,
                calls=usage["calls"],
                prompt_tokens=usage["prompt_tokens"],
                completion_tokens=usage["completion_tokens"],
                elapsed_seconds=self.llm.elapsed_seconds,
            )
            self.db.finish_run(
                run_id, summary=json.dumps(summary_stats, ensure_ascii=False)
            )
            summary_stats["usage"] = usage
            summary_stats["elapsed_seconds"] = round(self.llm.elapsed_seconds, 2)
            summary_stats["cost_estimate_usd"] = self._cost_estimate(usage)
            summary_stats["batch_sizer"] = self.batch_sizer.summary()
            return summary_stats
        except Exception as exc:  # noqa: BLE001
            self.db.fail_run(run_id, summary=str(exc))
            raise

    # ------------------------------------------------------------------ scene selection

    def _scene_pending(self, scene: Scene) -> bool:
        for unit in scene.units:
            if not unit.extra.get("translated", False):
                return True
        return False

    def _build_tracks(self, scenes: list[Scene]) -> list[list[Scene]]:
        """按分支轨道分组（保持首次出现顺序）。"""

        tracks: list[list[Scene]] = []
        order: dict[str, int] = {}
        for scene in scenes:
            if scene.branch not in order:
                order[scene.branch] = len(tracks)
                tracks.append([])
            tracks[order[scene.branch]].append(scene)
        return tracks

    # ------------------------------------------------------------------ execution

    def _run_tracks(
        self,
        tracks: list[list[Scene]],
        dry_run: bool,
        stats: dict[str, Any],
    ) -> None:
        branch_cfg = self.cfg.get("branch") or {}
        parallel = bool(branch_cfg.get("parallel", False)) and len(tracks) > 1
        workers = int(self.cfg.get("context", {}).get("max_workers", 4))
        if not parallel or workers <= 1:
            for track in tracks:
                self._run_track(track, dry_run, stats)
            return
        with ThreadPoolExecutor(max_workers=min(workers, len(tracks))) as pool:
            futures = [pool.submit(self._run_track, track, dry_run, stats) for track in tracks]
            for future in futures:
                future.result()

    def _run_track(self, track: list[Scene], dry_run: bool, stats: dict[str, Any]) -> None:
        branch = track[0].branch
        scene_counter = 0
        for scene in track:
            if self._budget and self._usage_total() >= self._budget:
                print(
                    f"[翻译] 已达 token 预算 {self._budget}，保存进度退出（重跑续传）"
                )
                break
            self._emit_progress(stats, "scene_start", scene)
            print(
                f"[翻译] 场景 {scene.scene_id} 开始（分支 {scene.branch}，"
                f"本轨道第 {scene_counter + 1}/{len(track)} 个）"
            )
            translations, term_misses, banned = self._process_scene(scene, dry_run, stats)
            self._all_translations.update(translations)
            scene_counter += 1
            if (
                translations
                and not dry_run
                and not self.cfg.get("review", {}).get("enabled", False)
            ):
                self.adapter.backfill(translations)
                with self._db_lock:
                    for unit_id in translations:
                        self.db.set_unit_status(unit_id, "translated")
            self._bump(stats, "scenes_done", 1)
            self._bump(stats, "units_translated", len(translations))
            self._emit_progress(
                stats,
                "scene_done",
                scene,
                term_misses=len(term_misses),
                banned_hits=banned,
                approvals_queued=stats.get("approvals_queued", 0),
            )
            print(
                f"[翻译] 场景 {scene.scene_id} 完成：译文 {len(translations)} 行，"
                f"术语漏翻 {len(term_misses)}，反翻译腔 {banned}"
            )

            every = int(self.cfg.get("context", {}).get("summary_every", 5))
            if not dry_run and scene_counter % every == 0:
                self._refresh_summary(branch, scene, translations)

    def _emit_progress(
        self,
        stats: dict[str, Any],
        phase: str,
        scene: Scene,
        **extra: Any,
    ) -> None:
        """输出结构化进度行（task_session 会转成 TaskStatusStore.progress）。"""

        payload: dict[str, Any] = {
            "phase": phase,
            "scene_id": scene.scene_id,
            "branch": scene.branch,
            "scenes_done": stats.get("scenes_done", 0),
            "scenes_total": stats.get("scenes_total", 0),
            "units_done": stats.get("units_translated", 0),
            "units_total": stats.get("units_total", 0),
        }
        payload.update(extra)
        print("@progress " + json.dumps(payload, ensure_ascii=False))

    def _bump(self, stats: dict[str, Any], key: str, delta: int) -> None:
        """并行轨道下对 stats 字典做原子累加，避免计数竞态。"""

        with self._stats_lock:
            stats[key] = stats.get(key, 0) + delta

    def _usage_total(self) -> int:
        usage = self.llm.usage_snapshot()
        return int(usage.get("prompt_tokens") or 0) + int(
            usage.get("completion_tokens") or 0
        )

    def _prefill_reuse(self, document: Any) -> int:
        """从项目 TM 预回填同源同指纹译文（不调 LLM），返回复用条数。"""

        translations, _tokens = _match_reusable(document, self.db)
        if not translations:
            return 0
        self.db.sync_units(document)
        self.adapter.backfill(translations)
        with self._db_lock:
            for unit_id in translations:
                self.db.set_unit_status(unit_id, "translated")
        return len(translations)

    def _process_scene(
        self,
        scene: Scene,
        dry_run: bool,
        stats: dict[str, Any],
    ) -> tuple[dict[str, str], list[dict[str, str]], int]:
        units = [u for u in scene.units if not u.extra.get("translated", False)]
        if not units:
            return {}, [], 0
        sources = [u.source for u in units]
        with self._db_lock:
            memory = build_memory_pack(
                self.db,
                self.llm,
                self.cfg,
                scene,
                sources,
                main_branch=getattr(self, "_main_branch", "main"),
            )
        # 智能分批：字符串场景无剧情上下文，跳过场景理解（省调用且不损失质量）
        understanding = None
        if any(u.kind != "string" for u in units):
            understanding = generate_understanding(self.llm, self.cfg, scene, memory)
            if understanding is not None:
                with self._db_lock:
                    self.db.save_understanding(understanding, scene.branch)
                    queued = queue_rolling_flags(self.db, understanding.flags)
                self._bump(stats, "approvals_queued", queued)

        # 场景级理解一次；重写按子批逐批执行（批大小由 BatchSizer 动态提供）
        max_units, max_tokens = self.batch_sizer.params()
        sub_batches = split_units(units, max_units, max_tokens)
        self._bump(stats, "sub_batches_total", len(sub_batches))

        translations: dict[str, str] = {}
        sub_records: list[dict[str, Any]] = []
        for index, sub in enumerate(sub_batches, 1):
            sub_started = time.monotonic()
            before = self.llm.usage_snapshot()
            sub_translations = rewrite_scene(
                self.llm, self.cfg, scene, memory, understanding, units=sub
            )
            after = self.llm.usage_snapshot()
            translations.update(sub_translations)
            record = {
                "scene_id": scene.scene_id,
                "sub_index": index,
                "sub_total": len(sub_batches),
                "units": len(sub),
                "source_units": sum(1 for u in sub if u.source),
                "translated": len(sub_translations),
                "prompt_tokens": after["prompt_tokens"] - before["prompt_tokens"],
                "completion_tokens": after["completion_tokens"] - before["completion_tokens"],
                "elapsed_s": round(time.monotonic() - sub_started, 2),
                "retries": max(0, after["calls"] - before["calls"] - 1),
            }
            sub_records.append(record)
            self.batch_sizer.record(record)
            self._bump(stats, "sub_batches_done", 1)
            self._emit_progress(
                stats,
                "sub_batch",
                scene,
                sub_batch_current=index,
                sub_batch_total=len(sub_batches),
                units_in_batch=len(sub),
                units_translated_batch=len(sub_translations),
            )
        with self._stats_lock:
            stats.setdefault("sub_batch_records", []).extend(sub_records)

        with self._db_lock:
            for unit in units:
                translation = translations.get(unit.unit_id)
                if translation:
                    fp = unit_context_fp(unit, scene)
                    self.db.tm_put(unit.source, unit.unit_id, translation, fp)

        # 质量门禁（报告不阻塞）
        term_misses = self._term_audit(translations, units)
        banned = self._banned_audit(translations)
        self._bump(stats, "term_misses", len(term_misses))
        self._bump(stats, "banned_hits", banned)

        # 周期性一致性复查（polish）
        every = int(self.cfg.get("context", {}).get("polish_every", 5))
        if not dry_run and scene.order and scene.order % every == 0:
            corrections = self._polish_scene(scene, translations)
            translations.update(corrections)
        return translations, term_misses, banned

    def _refresh_summary(self, branch: str, scene: Scene, translations: dict[str, str]) -> None:
        sources = "\n".join(u.source for u in scene.units)
        translated = "\n".join(translations.values())
        new_text = f"{sources}\n\n译文：\n{translated}"
        with self._db_lock:
            old = self.db.get_summary(branch)
            updated = update_summary(self.llm, self.cfg, old, new_text)
            if updated:
                self.db.save_summary(branch, updated, scene.order)

    # ------------------------------------------------------------------ gates & polish

    def _term_audit(self, translations: dict[str, str], units: list[Any]) -> list[dict[str, str]]:
        from tav2.gates import term_audit

        locked = self.db.locked_terms()
        sources = {u.unit_id: u.source for u in units}
        return term_audit(translations, sources, locked)

    def _banned_audit(self, translations: dict[str, str]) -> int:
        from tav2.gates import banned_word_hits

        return sum(len(banned_word_hits(t)) for t in translations.values())

    def _polish_scene(self, scene: Scene, translations: dict[str, str]) -> dict[str, str]:
        """一致性复查：携带摘要与角色画像，返回需修正的项。"""

        items: list[tuple[str, str, str]] = []
        for unit in scene.units:
            if unit.unit_id in translations:
                items.append((unit.unit_id, unit.source, translations[unit.unit_id]))
        if not items:
            return {}
        with self._db_lock:
            profiles = self._profiles(scene)
            summary = self.db.get_summary(scene.branch)
        prompt = render(
            POLISH_PROMPT.template,
            summary=summary or "（无）",
            profiles=profiles or "（无）",
        )
        lines = ["待复查项："]
        for key, source, translated in items:
            lines.append(f"标识符: {key}")
            lines.append(f"源: {source}")
            lines.append(f"译: {translated}")
        try:
            data = extract_json(self.llm.chat("你是翻译一致性复查器。", prompt + "\n\n" + "\n".join(lines)))
        except (LLMError, ValueError, TypeError):
            return {}
        from tav2.gates import tags_preserved
        from tav2.adapters.renpy.renpy_compat import ensure_translation_tag

        corrections: dict[str, str] = {}
        src_map = {key: source for key, source, _t in items}
        for key, value in data.items():
            key = str(key).strip()
            text = str(value).strip()
            if key not in src_map or not text:
                continue
            if not tags_preserved(src_map[key], text):
                continue
            corrections[key] = ensure_translation_tag(src_map[key], text)
        return corrections

    def _profiles(self, scene: Scene) -> str:
        characters = self.db.get_characters()
        rows: list[str] = []
        seen: set[str] = set()
        for unit in scene.units:
            if not unit.speaker or unit.speaker in seen:
                continue
            seen.add(unit.speaker)
            info = characters.get(unit.speaker) or {}
            name = str(info.get("name_zh") or "")
            note = str(info.get("style_notes") or "")
            rows.append(f"- {unit.speaker}={name}" + (f"：{note}" if note else ""))
        return "\n".join(rows)

    def _cost_estimate(self, usage: dict[str, int]) -> float:
        llm_cfg = self.cfg.get("llm") or {}
        in_price = float(llm_cfg.get("price_per_1m_input") or 0.0)
        out_price = float(llm_cfg.get("price_per_1m_output") or 0.0)
        if not in_price and not out_price:
            return 0.0
        return round(
            usage.get("prompt_tokens", 0) / 1_000_000 * in_price
            + usage.get("completion_tokens", 0) / 1_000_000 * out_price,
            4,
        )
