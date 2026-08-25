"""全流程主管 Agent：主管循环、工具注册表、分级自主与审批队列。

主管循环 = 注入项目快照 → 模型选择动作/给出结论 → 按自主级别执行或挂起审批 →
观察结果写回 → 下一轮。现有执行体（TranslateRunner / deliberation / worldbook /
terms / backfill / deploy）原样保留，主管只决定"做什么/做不做"。

自主级别：
- suggest：read 自动执行；draft/mutate 进审批队列（人工闸门）。
- auto_low（默认）：read/draft 自动执行，mutate（回填/部署）进审批。
- auto_high：read/draft/mutate 自动执行。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from tav2.agent_llm import AgentLLM, ToolCall
from tav2.config import resolve_project_dir
from tav2.db import ProjectDB
from tav2.llm import BaseLLM, create_llm


AUTONOMY_LEVELS = ("suggest", "auto_low", "auto_high")
_DEFAULT_GOAL = "完成当前项目的翻译与一致性修复（术语统一、同源句一致、回填审校）"
_HISTORY_LIMIT = 40

_AUTONOMY_ALLOW: dict[str, set[str]] = {
    "suggest": {"read"},
    "auto_low": {"read", "draft"},
    "auto_high": {"read", "draft", "mutate"},
}


@dataclass
class AgentConfig:
    """agent 配置（config.agent 段，缺省与旧配置兼容）。"""

    enabled: bool = False
    autonomy: str = "auto_low"
    model: str = ""
    reasoning_effort: str = ""
    max_turns: int = 30

    @classmethod
    def from_cfg(cls, cfg: dict[str, Any]) -> "AgentConfig":
        raw = cfg.get("agent") or {}
        autonomy = str(raw.get("autonomy") or "auto_low").strip().lower()
        if autonomy not in AUTONOMY_LEVELS:
            autonomy = "auto_low"
        return cls(
            enabled=bool(raw.get("enabled", False)),
            autonomy=autonomy,
            model=str(raw.get("model") or "").strip(),
            reasoning_effort=str(raw.get("reasoning_effort") or "").strip(),
            max_turns=max(1, int(raw.get("max_turns") or 30)),
        )


@dataclass
class ToolSpec:
    """工具注册表条目：名称/描述/JSON Schema 参数/类别/执行函数。"""

    name: str
    description: str
    parameters: dict[str, Any]
    category: str
    handler: Callable[["AgentContext", dict[str, Any]], dict[str, Any]]

    def to_schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "category": self.category,
        }


@dataclass
class AgentContext:
    """工具执行上下文：配置、项目路径、DB、自主级别与运行器引用。"""

    cfg: dict[str, Any]
    game_dir: Path
    project_dir: Path
    db: ProjectDB
    llm: BaseLLM
    autonomy: str
    runner: "AgentRunner | None" = None
    session_id: str = ""


def _validate_args(spec: ToolSpec, args: dict[str, Any]) -> dict[str, Any]:
    required = spec.parameters.get("required") or []
    for key in required:
        if key not in args or args[key] in (None, ""):
            raise ValueError(f"缺少必填参数：{key}")
    return dict(args or {})


# ---------------------------------------------------------------- 工具实现

def _tl_pending_stats(ctx: AgentContext) -> dict[str, Any]:
    """从 tl 工作文件解析真实待译单元（不依赖 DB units 缓存，0 LLM token）。

    DB 的 units 表只在 TranslateRunner 跑过之后才有数据；新项目/未初始化时
    units 表为空，但 tl 模板里可能全是待译文本。主管必须以这里的 pending 为准。
    """

    try:
        from tav2.adapters import get_adapter
        from tav2.translate import merge_string_scenes

        adapter = get_adapter(ctx.cfg)
        doc = adapter.extract()
        merge_string_scenes(doc)
        scenes = [s for s in doc.scenes if s.units]
        total = sum(len(s.units) for s in scenes)
        pending = sum(
            len([u for u in s.units if not u.extra.get("translated", False)])
            for s in scenes
        )
        return {
            "scenes": len(scenes),
            "units_total": total,
            "units_pending": pending,
            "units_translated": total - pending,
        }
    except Exception as exc:  # noqa: BLE001 快照不应因解析失败而崩溃
        return {"error": str(exc)[:200]}


def _tool_snapshot(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """项目状态快照：单元/术语/世界书/待审批/最近运行（0 LLM token）。"""

    db = ctx.db
    units = db.unit_stats()
    terms = db.all_terms()
    counts = {"locked": 0, "candidate": 0, "rejected": 0}
    for t in terms:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    return {
        "stats": {
            "units_total": units["total"],
            "units_translated": units["translated"],
            "units_pending": units["pending"],
        },
        "tl": _tl_pending_stats(ctx),  # 真实待译量（以 tl 工作文件为准）
        "terms": counts,
        "worldbook_entries": len(db.load_worldbook(active_only=False)),
        "pending_approvals": len(db.pending_approvals()),
        "pending_agent_actions": len(db.pending_agent_actions(ctx.session_id)),
        "recent_runs": [
            {
                "run_id": r["run_id"],
                "kind": r["kind"],
                "status": r["status"],
                "summary": str(r["summary"])[:80],
            }
            for r in db.recent_runs(3)
        ],
        "last_review_sheet": db.get_meta("last_review_sheet"),
        "main_summary": db.get_summary("main")[:300],
    }


def _tool_plan(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """记录当前目标的执行计划（会话模式首个动作，只读不执行）。"""

    if not ctx.session_id:
        raise ValueError("plan 工具仅限常驻会话模式使用")
    steps = args.get("steps") or []
    if not isinstance(steps, list) or not steps:
        raise ValueError("plan 需要非空 steps 数组")
    cleaned: list[dict[str, Any]] = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        title = str(s.get("title") or "").strip()
        tool = str(s.get("tool") or "").strip()
        if not title or not tool or tool not in TOOL_REGISTRY:
            continue
        cleaned.append({"title": title, "tool": tool, "note": str(s.get("note") or "")})
    if not cleaned:
        raise ValueError("plan steps 每一项都需要 title 与已注册的 tool")
    ctx.db.session_set_plan(ctx.session_id, cleaned)
    return {"ok": True, "steps": len(cleaned), "plan": cleaned}


def _tool_check(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """运行一致性审计与回填校验（标签保持/标识符缺失）。"""

    from tav2.adapters import get_adapter

    adapter = get_adapter(ctx.cfg)
    return {
        "verify": adapter.verify(),
        "units": ctx.db.unit_stats(),
        "tl": _tl_pending_stats(ctx),
    }


def _tool_search(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """联网查证官方/社区译名（deepseek/tavily/duckduckgo，带缓存降级）。"""

    from tav2.websearch import search

    query = str(args.get("query") or "").strip()
    if not query:
        raise ValueError("query 不能为空")
    results = search(ctx.cfg, ctx.db, query)
    return {"query": query, "count": len(results), "results": results[:10]}


def _tool_deliberate(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """译前推敲：对候选术语多方位评估（联网查证 + LLM 决策），写回 DB。"""

    from tav2.deliberation import evaluate_candidates

    return evaluate_candidates(ctx.llm, ctx.db, ctx.cfg)


def _tool_worldbook(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """生成世界书条目并落库（force 可覆盖已有）。"""

    from tav2.adapters import get_adapter
    from tav2.worldbook import generate_worldbook

    adapter = get_adapter(ctx.cfg)
    lines = adapter.scan_lines()
    if not lines:
        return {"ok": True, "entries": 0, "lines": 0}
    existing = ctx.db.load_worldbook(active_only=False)
    force = bool(args.get("force", False))
    if existing and not force:
        return {
            "ok": True,
            "entries": len(existing),
            "skipped": True,
            "note": "世界书已存在，force=true 可重新生成",
        }
    entries = generate_worldbook(ctx.llm, ctx.cfg, lines)
    ctx.db.save_worldbook([e.to_dict() for e in entries])
    return {"ok": True, "entries": len(entries), "lines": len(lines)}


def _tool_terms(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """快筛术语候选入库（不覆盖已锁定项）。"""

    from tav2.adapters import get_adapter
    from tav2.scanning import scan_lines as scan_candidates
    from tav2.terms import seed_terms

    adapter = get_adapter(ctx.cfg)
    lines = adapter.scan_lines()
    candidates = scan_candidates(lines, ctx.cfg)
    seeded = seed_terms(ctx.db, candidates)
    return {"scanned": len(lines), "candidates": len(candidates), "seeded": seeded}


def _tool_translate(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """双阶段翻译（强制审校模式：产审校表，不直写 tl）。"""

    from tav2.adapters import get_adapter
    from tav2.translate import TranslateRunner

    limit = max(0, int(args.get("limit") or 0))
    batch_mode = str(args.get("batch_mode") or "").strip()
    budget = max(0, int(args.get("budget") or 0))
    if not budget:
        budget = max(0, int(ctx.cfg.get("context", {}).get("budget_tokens", 0) or 0))
    cfg = dict(ctx.cfg)
    cfg["review"] = dict(ctx.cfg.get("review") or {})
    cfg["review"]["enabled"] = True
    adapter = get_adapter(cfg)
    # auto 模式默认编排成本策略：先同源复用预回填（不调 LLM），再跑动态分批翻译
    reuse_stats = None
    if batch_mode == "auto" and args.get("reuse", True) is not False:
        from tav2.translate import apply_reuse

        reuse_stats = apply_reuse(ctx.cfg, adapter, ctx.db)
    runner = TranslateRunner(cfg, adapter, ctx.db, ctx.llm)
    stats = runner.run(limit=limit or None, batch_mode=batch_mode, budget=budget)
    result = {
        "run_id": stats.get("run_id"),
        "scenes_done": stats.get("scenes_done"),
        "units_translated": stats.get("units_translated"),
        "reused_units": stats.get("reused_units"),
        "sub_batches_done": stats.get("sub_batches_done"),
        "term_misses": stats.get("term_misses"),
        "banned_hits": stats.get("banned_hits"),
        "approvals_queued": stats.get("approvals_queued"),
        "review_sheet": stats.get("review_sheet"),
    }
    if reuse_stats and reuse_stats.get("applied"):
        result["reuse_applied"] = reuse_stats["applied"]
        result["reuse_saved_prompt_tokens_est"] = reuse_stats.get(
            "saved_prompt_tokens_est", 0
        )
    return result


def _tool_reuse(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """TM 同源+同上下文指纹复用：dry-run 预览或 apply 预回填（不调 LLM）。"""

    from tav2.adapters import get_adapter
    from tav2.translate import apply_reuse, preview_reuse

    mode = str(args.get("mode") or "dry-run").strip()
    adapter = get_adapter(ctx.cfg)
    if mode == "apply":
        return apply_reuse(ctx.cfg, adapter, ctx.db)
    return preview_reuse(ctx.cfg, adapter, ctx.db)


def _tool_plan_batches(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """按当前批大小策略（含自适应开关）预览子批数与调用预估。"""

    from tav2.adapters import get_adapter
    from tav2.translate import plan_batches

    return plan_batches(ctx.cfg, get_adapter(ctx.cfg))


def _match_review_unit(row: dict[str, Any], meta: dict[str, Any]):
    """把审校行映射回 Unit（按文件/标识符/序号或字符串 old）。"""

    row_type = str(row.get("类型") or "")
    filename = str(row.get("文件") or "")
    if row_type == "dialogue":
        identifier = str(row.get("标识符") or "")
        try:
            say_index = int(row.get("序号") or 0)
        except (TypeError, ValueError):
            say_index = 0
        unit = meta.get(f"{identifier}#{say_index}")
        if unit is not None and unit.extra.get("file") == filename:
            return unit
        return None
    if row_type == "string":
        old = str(row.get("标识符") or "")
        for unit in meta.values():
            if (
                unit.kind == "string"
                and unit.extra.get("file") == filename
                and unit.source == old
            ):
                return unit
    return None


def _tool_backfill(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """读审校表回填 tl：仅放行已确认/已修改行，并同步 DB 状态与 TM。"""

    from tav2.adapters import get_adapter
    from tav2.adapters.renpy.backfill import backfill_review, iter_applied_rows
    from tav2.review import read_review_sheet

    force = bool(args.get("force", False))
    if force and ctx.autonomy != "auto_high":
        raise PermissionError("backfill force 仅允许 auto_high 自主级别使用")
    adapter = get_adapter(ctx.cfg)
    review_arg = str(args.get("review") or "").strip()
    if review_arg:
        path = Path(review_arg)
        if not path.is_absolute():
            path = ctx.project_dir / path
        path = path.resolve()
        if not str(path).startswith(str(ctx.project_dir.resolve())):
            raise PermissionError("审校表路径必须位于项目目录内")
        if not path.exists():
            raise ValueError(f"审校表不存在：{path}")
    else:
        candidates = sorted(
            ctx.project_dir.glob("review_*.xlsx"),
            key=lambda p: p.stat().st_mtime,
        )
        if not candidates:
            return {
                "ok": False,
                "error": f"项目目录下没有 review_*.xlsx 审校表（{ctx.project_dir}）",
            }
        path = candidates[-1]
    rows = read_review_sheet(path)
    applied_rows = list(iter_applied_rows(rows, force=force))
    stats = backfill_review(adapter.game_dir, adapter.lang, rows, force=force)
    synced = 0
    if applied_rows:
        from tav2.translate import unit_context_fp

        document = adapter.extract()
        meta = {u.unit_id: u for u in document.all_units()}
        scene_by_unit = {
            u.unit_id: scene for scene in document.scenes for u in scene.units
        }
        for row in applied_rows:
            unit = _match_review_unit(row, meta)
            if unit is None:
                continue
            translation = str(row.get("人工译文") or row.get("机器译文") or "").strip()
            if not translation:
                continue
            ctx.db.set_unit_status(unit.unit_id, "translated")
            fp = (
                unit_context_fp(unit, scene_by_unit[unit.unit_id])
                if unit.unit_id in scene_by_unit
                else ""
            )
            ctx.db.tm_put(unit.source, unit.unit_id, translation, fp)
            synced += 1
    stats["review"] = path.name
    stats["db_synced"] = synced
    return stats


def _tool_deploy(ctx: AgentContext, args: dict[str, Any]) -> dict[str, Any]:
    """把 tl/<lang> 部署到目标游戏目录（复制，不删除源）。"""

    import shutil

    from tav2.adapters import get_adapter

    adapter = get_adapter(ctx.cfg)
    target = Path(str(args.get("target") or "")).expanduser()
    if not target.is_absolute():
        target = (ctx.project_dir / target).resolve()
    gamedir = (
        adapter.game_dir / "game"
        if (adapter.game_dir / "game").is_dir()
        else adapter.game_dir
    )
    tl_dir = gamedir / "tl" / adapter.lang
    if not tl_dir.exists():
        raise ValueError(f"未找到 {tl_dir}")
    target_game = target / "game" if (target / "game").is_dir() else target
    target_tl = target_game / "tl" / adapter.lang
    if target_tl.resolve() == tl_dir.resolve():
        raise PermissionError("目标目录不能与源 tl 相同")
    shutil.copytree(tl_dir, target_tl, dirs_exist_ok=True)
    return {"ok": True, "deployed_to": str(target_tl)}


TOOL_REGISTRY: dict[str, ToolSpec] = {
    "snapshot": ToolSpec(
        name="snapshot",
        description="获取当前项目状态快照（单元/术语/世界书/待审批/最近运行/审校表）。stats 来自 DB 缓存；tl.units_pending 是从 tl 工作文件解析的真实待译量，DB 未入库时也以此为准。通常每个行动轮先调用它再决定下一步。",
        parameters={"type": "object", "properties": {}},
        category="read",
        handler=_tool_snapshot,
    ),
    "plan": ToolSpec(
        name="plan",
        description="记录当前目标的执行计划（步骤清单）。每个目标的第一轮必须先调用本工具。",
        parameters={
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "description": "计划步骤；tool 必须是后续实际会调用的工具名",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "步骤标题"},
                            "tool": {"type": "string", "description": "对应工具名"},
                            "note": {"type": "string", "description": "说明（可选）"},
                        },
                        "required": ["title", "tool"],
                    },
                }
            },
            "required": ["steps"],
        },
        category="read",
        handler=_tool_plan,
    ),
    "check": ToolSpec(
        name="check",
        description="运行一致性审计与回填校验（标识符缺失/标签违规/单元统计）。",
        parameters={"type": "object", "properties": {}},
        category="read",
        handler=_tool_check,
    ),
    "search": ToolSpec(
        name="search",
        description="联网查证官方/社区译名（deepseek/tavily/duckduckgo，失败自动降级）。",
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string", "description": "搜索查询"}},
            "required": ["query"],
        },
        category="read",
        handler=_tool_search,
    ),
    "deliberate": ToolSpec(
        name="deliberate",
        description="译前推敲：对候选术语多方位评估（查证+决策），高置信自动锁定，低置信进审批队列。",
        parameters={"type": "object", "properties": {}},
        category="draft",
        handler=_tool_deliberate,
    ),
    "worldbook": ToolSpec(
        name="worldbook",
        description="生成世界书条目并落库（force=true 覆盖已有条目）。",
        parameters={
            "type": "object",
            "properties": {"force": {"type": "boolean", "description": "覆盖已有条目，默认 false"}},
        },
        category="draft",
        handler=_tool_worldbook,
    ),
    "terms": ToolSpec(
        name="terms",
        description="扫描原文并快筛术语候选入库（status=candidate，供后续 deliberate 推敲）。",
        parameters={"type": "object", "properties": {}},
        category="draft",
        handler=_tool_terms,
    ),
    "translate": ToolSpec(
        name="translate",
        description="双阶段翻译指定范围（审校模式，产出审校表与机器译文，不直接写 tl）。limit=0 表示全部待译场景。",
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "只翻译前 N 个场景，0=全部"},
                "batch_mode": {"type": "string", "description": "auto=动态批大小（失败收缩/成功放大）；fixed/留空=固定配置"},
                "budget": {"type": "integer", "description": "本轮总 token 预算，超出即保存进度退出（重跑续传），0=不限"},
            },
        },
        category="draft",
        handler=_tool_translate,
    ),
    "reuse": ToolSpec(
        name="reuse",
        description="TM 同源+同上下文指纹复用：dry-run 预览可复用行数与预估节省 token；apply 直接预回填（不调 LLM）。",
        parameters={
            "type": "object",
            "properties": {
                "mode": {"type": "string", "description": "dry-run | apply，默认 dry-run"}
            },
        },
        category="mutate",
        handler=_tool_reuse,
    ),
    "plan-batches": ToolSpec(
        name="plan-batches",
        description="按当前批大小策略（含自适应开关）预览子批数与调用预估，翻译前可用。",
        parameters={"type": "object", "properties": {}},
        category="read",
        handler=_tool_plan_batches,
    ),
    "backfill": ToolSpec(
        name="backfill",
        description="读审校表已确认行回填 tl 并同步 DB 状态与翻译记忆。review 留空取最新审校表；force 仅 auto_high 可用。",
        parameters={
            "type": "object",
            "properties": {
                "review": {"type": "string", "description": "审校表文件名（可选，默认取最新）"},
                "force": {"type": "boolean", "description": "回填全部行（含未确认），仅 auto_high"},
            },
        },
        category="mutate",
        handler=_tool_backfill,
    ),
    "deploy": ToolSpec(
        name="deploy",
        description="把 tl/<lang> 部署到目标游戏目录（复制，不删除源）。",
        parameters={
            "type": "object",
            "properties": {"target": {"type": "string", "description": "目标游戏根目录"}},
            "required": ["target"],
        },
        category="mutate",
        handler=_tool_deploy,
    ),
}


def _tool_descriptions() -> str:
    lines = []
    for spec in TOOL_REGISTRY.values():
        lines.append(f"- {spec.name}（类别：{spec.category}）：{spec.description}")
    return "\n".join(lines)


# ---------------------------------------------------------------- 主管循环


class AgentRunner:
    """主管循环运行器：快照 → 模型动作/结论 → 分级执行或审批 → 观察回写。"""

    def __init__(
        self,
        cfg: dict[str, Any],
        *,
        goal: str = "",
        autonomy: str = "",
        max_turns: int = 0,
        run_id: str = "",
        resume: bool = False,
        session_id: str = "",
        llm: BaseLLM | None = None,
        progress: Callable[[int, int, str], None] | None = None,
    ) -> None:
        self.cfg = cfg
        self.acfg = AgentConfig.from_cfg(cfg)
        if autonomy:
            self.acfg.autonomy = autonomy if autonomy in AUTONOMY_LEVELS else "auto_low"
        if max_turns:
            self.acfg.max_turns = max(1, int(max_turns))
        self.goal = goal or _DEFAULT_GOAL
        self.autonomy = self.acfg.autonomy
        self.game_dir = Path(cfg["game_dir"])
        self.project_dir = resolve_project_dir(cfg, self.game_dir)
        self.lang = str(cfg["lang"])
        self.db = ProjectDB(self.project_dir / "db.sqlite")
        self.run_id = run_id or f"agent_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
        self.resume = bool(resume)
        self.session_id = session_id
        self.llm = llm or create_llm(cfg)
        self.agent_llm = AgentLLM(self.llm)
        self.progress = progress
        self.messages: list[dict[str, Any]] = []
        self.turns = 0
        self.bounced = False
        self.no_progress = 0
        self._saved = 0
        self.ctx = AgentContext(
            cfg,
            self.game_dir,
            self.project_dir,
            self.db,
            self.llm,
            self.autonomy,
            runner=self,
            session_id=session_id,
        )

    # ------------------------------------------------------------ 持久化

    def _save_history(self) -> None:
        for m in self.messages[self._saved :]:
            self.db.add_agent_message(
                self.session_id,
                self.run_id,
                str(m.get("role") or ""),
                content=str(m.get("content") or ""),
                tool_calls=m.get("tool_calls"),
                tool_call_id=str(m.get("tool_call_id") or ""),
            )
        self._saved = len(self.messages)

    def _history_messages(self) -> list[dict[str, Any]]:
        if len(self.messages) <= _HISTORY_LIMIT:
            return list(self.messages)
        actions = self.db.agent_actions_for_run(self.run_id, limit=50)
        digest = "；".join(f"{a['tool']}({a['status']})" for a in actions[-20:]) or "（无）"
        kept = list(self.messages[-(_HISTORY_LIMIT - 4) :])
        kept.insert(
            0,
            {
                "role": "user",
                "content": f"早期轮次动作摘要：{digest}（完整记录在 agent_actions 表）",
            },
        )
        return kept

    # ------------------------------------------------------------ 观测与护栏

    def _emit_progress(self, message: str) -> None:
        print(f"[agent] {message}")
        print(
            "@progress "
            + json.dumps(
                {
                    "phase": "agent",
                    "stage": "agent",
                    "current": self.turns,
                    "total": self.acfg.max_turns,
                    "message": message,
                },
                ensure_ascii=False,
            )
        )
        if self.progress:
            try:
                self.progress(self.turns, self.acfg.max_turns, message)
            except Exception:
                pass

    def _stop_requested(self) -> bool:
        row = self.db.get_agent_run(self.run_id)
        return bool(row and row.get("status") == "stopping")

    def _remaining_issues(self, snapshot: dict[str, Any]) -> bool:
        return bool(snapshot.get("pending_agent_actions"))

    def _build_system(self, snapshot: dict[str, Any]) -> str:
        parts = [
            "你是 tav2 翻译项目的全流程主管 Agent。",
            f"当前目标：{self.goal}",
            f"自主级别：{self.autonomy}"
            "（suggest=read 自动、draft/mutate 需人工批准；auto_low=read/draft 自动、mutate 需批准；"
            "auto_high=全部自动）",
            "项目快照：\n" + json.dumps(snapshot, ensure_ascii=False, indent=1)[:6000],
            "## 可用工具\n" + _tool_descriptions(),
            "## 主管循环\n"
            "每轮只输出一个 JSON 对象："
            '{"action": "<工具名>", "args": {...}} 表示调用工具；'
            '{"final": "<结论>"} 表示任务完成。不要输出 JSON 以外的任何文字。',
            "执行新目标的第一轮必须先调用 plan 工具记录计划。",
            "## 完成标准\n"
            "当目标对应的动作全部完成、且没有挂起的待审批动作时输出 final。\n"
            "注意：快照中 tl.units_pending 是真实待译单元数；若目标涉及补齐/翻译"
            "且 tl.units_pending > 0，必须先调用 translate 完成翻译，不得直接 final。",
        ]
        return "\n\n".join(parts)

    # ------------------------------------------------------------ 动作处理

    def _handle_call(self, call: ToolCall) -> int | None:
        spec = TOOL_REGISTRY.get(call.name)
        self.messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": call.arguments}
                ],
            }
        )
        if spec is None:
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": f"错误：未知工具 {call.name}。请从可用工具中选择。",
                }
            )
            return None
        try:
            args = _validate_args(spec, call.arguments)
        except ValueError as exc:
            action_id = self.db.insert_agent_action(
                self.run_id, self.turns, call.name, call.arguments, spec.category,
                "failed", error=str(exc),
            )
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": f"参数校验失败：{exc}",
                }
            )
            return action_id

        if spec.category not in _AUTONOMY_ALLOW.get(self.autonomy, set()):
            action_id = self.db.insert_agent_action(
                self.run_id, self.turns, call.name, args, spec.category, "pending"
            )
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": (
                        f"已挂起审批（动作 #{action_id}，工具 {call.name}，"
                        f"类别 {spec.category}）。等待人工批准；可先执行其他动作或输出结论。"
                    ),
                }
            )
            return action_id

        try:
            result = spec.handler(self.ctx, args)
            action_id = self.db.insert_agent_action(
                self.run_id, self.turns, call.name, args, spec.category, "done",
                result=json.dumps(result, ensure_ascii=False)[:4000],
            )
            if self.session_id:
                self.db.session_mark_plan_step(self.session_id, call.name)
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, ensure_ascii=False)[:2000],
                }
            )
            return action_id
        except Exception as exc:  # noqa: BLE001
            action_id = self.db.insert_agent_action(
                self.run_id, self.turns, call.name, args, spec.category, "failed",
                error=str(exc),
            )
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": f"工具 {call.name} 执行失败：{exc}",
                }
            )
            return action_id

    # ------------------------------------------------------------ 主循环

    def run(self) -> dict[str, Any]:
        if self.session_id:
            self.db.create_agent_session(self.session_id)
        self.db.upsert_agent_run(
            self.run_id,
            self.session_id,
            self.goal,
            self.autonomy,
            "react",
            "running",
            turns=0,
        )
        if self.resume:
            self.messages = self.db.agent_messages(
                session_id=self.session_id, run_id=self.run_id, limit=200
            )
            self._saved = len(self.messages)
            self.turns = int((self.db.get_agent_run(self.run_id) or {}).get("turns") or 0)
        else:
            self.messages = []
            self.turns = 0
            self._saved = 0
            self.messages.append({"role": "user", "content": self.goal})
            self._save_history()
        self._emit_progress("主管循环启动")

        while self.turns < self.acfg.max_turns:
            if self._stop_requested():
                return self._finish("stopped", "收到停止请求，主管循环已终止")
            snapshot = _tool_snapshot(self.ctx, {})
            try:
                turn = self.agent_llm.turn(
                    self._build_system(snapshot),
                    self._history_messages(),
                    [t.to_schema() for t in TOOL_REGISTRY.values()],
                )
            except Exception as exc:  # noqa: BLE001
                return self._finish("failed", f"主管模型调用失败：{exc}")

            self.turns += 1
            if turn.is_final:
                if self._remaining_issues(snapshot) and not self.bounced:
                    self.bounced = True
                    self.messages.append(
                        {
                            "role": "user",
                            "content": (
                                "你宣告任务完成，但仍有待审批动作未处理，"
                                "请继续处理或明确说明需要人工介入。"
                            ),
                        }
                    )
                    self._save_history()
                    self._emit_progress("done 门打回：存在待审批动作")
                    continue
                suffix = "（存在待审批动作，主管坚持收尾）" if self.bounced else ""
                return self._finish("done", f"主管判定完成{suffix}：{turn.content[:200]}")

            executed = 0
            pending = 0
            for call in turn.tool_calls:
                action_id = self._handle_call(call)
                if action_id is not None:
                    row = self.db.get_agent_action(action_id)
                    if row is not None:
                        if row["status"] == "pending":
                            pending += 1
                        elif row["status"] == "done":
                            executed += 1
            self.db.set_agent_run_turns(self.run_id, self.turns)
            if executed == 0 and pending == 0:
                self.no_progress += 1
                if self.no_progress >= 2:
                    return self._finish("stopped", "连续多轮无有效动作，主管循环自动停止")
            else:
                self.no_progress = 0
            self._save_history()
            self._emit_progress(
                f"第 {self.turns} 轮：执行 {executed} 个动作，挂起审批 {pending} 个"
            )

        return self._finish("stopped", f"达到最大轮数 {self.acfg.max_turns}，主管循环停止")

    def _finish(self, status: str, summary: str) -> dict[str, Any]:
        self.db.set_agent_run_status(self.run_id, status, summary=summary)
        self._save_history()
        self._emit_progress(f"主管循环结束：{status}")
        return {
            "run_id": self.run_id,
            "status": status,
            "turns": self.turns,
            "summary": summary[:500],
            "protocol": "react",
        }


# ---------------------------------------------------------------- 外部入口


def run_agent(
    cfg: dict[str, Any],
    *,
    goal: str = "",
    autonomy: str = "",
    max_turns: int = 0,
    run_id: str = "",
    resume: bool = False,
    session_id: str = "",
    llm: BaseLLM | None = None,
    progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """启动一次主管循环（Web/CLI 共用）。"""

    runner = AgentRunner(
        cfg,
        goal=goal,
        autonomy=autonomy,
        max_turns=max_turns,
        run_id=run_id,
        resume=resume,
        session_id=session_id,
        llm=llm,
        progress=progress,
    )
    return runner.run()


def make_context(cfg: dict[str, Any], db: ProjectDB | None = None) -> AgentContext:
    """构造工具执行上下文（审批重放用）。"""

    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = db or ProjectDB(project_dir / "db.sqlite")
    autonomy = AgentConfig.from_cfg(cfg).autonomy
    return AgentContext(
        cfg, game_dir, project_dir, db, create_llm(cfg), autonomy
    )


def approve_action(cfg: dict[str, Any], action_id: int) -> dict[str, Any]:
    """批准待审批动作：按存储的 args 重放执行（幂等）。"""

    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    row = db.get_agent_action(int(action_id))
    if row is None:
        return {"ok": False, "error": f"动作不存在：{action_id}"}
    if row["status"] != "pending":
        return {"ok": False, "error": f"动作状态为 {row['status']}，无法批准"}
    spec = TOOL_REGISTRY.get(row["tool"])
    if spec is None:
        db.set_agent_action_status(int(action_id), "failed", error="工具已不存在")
        return {"ok": False, "error": f"工具 {row['tool']} 不存在"}
    ctx = make_context(cfg, db)
    try:
        result = spec.handler(ctx, row["args"])
        db.set_agent_action_status(
            int(action_id),
            "approved",
            result=json.dumps(result, ensure_ascii=False)[:4000],
        )
        return {"ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001
        db.set_agent_action_status(int(action_id), "failed", error=str(exc))
        return {"ok": False, "error": f"批准执行失败：{exc}"}


def reject_action(
    cfg: dict[str, Any], action_id: int, reason: str = ""
) -> dict[str, Any]:
    """拒绝待审批动作（仅置状态，不产生副作用）。"""

    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    row = db.get_agent_action(int(action_id))
    if row is None:
        return {"ok": False, "error": f"动作不存在：{action_id}"}
    if row["status"] != "pending":
        return {"ok": False, "error": f"动作状态为 {row['status']}，无法拒绝"}
    db.set_agent_action_status(int(action_id), "rejected", error=str(reason or "")[:500])
    return {"ok": True}


def agent_status(cfg: dict[str, Any]) -> dict[str, Any]:
    """最近运行 + 待审批动作 + 历史（Web/CLI 共用）。"""

    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    return {
        "run": db.latest_agent_run(),
        "pending": db.pending_agent_actions(),
        "recent": db.recent_agent_runs(5),
    }


def stop_agent(cfg: dict[str, Any], run_id: str = "") -> dict[str, Any]:
    """请求停止运行中的 agent（轮间生效）。"""

    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    run = db.get_agent_run(run_id) if run_id else db.latest_agent_run()
    if run is None:
        return {"ok": False, "error": "没有 agent 运行记录"}
    if run["status"] == "running":
        db.set_agent_run_status(run["run_id"], "stopping", summary="人工请求停止")
        return {"ok": True, "run_id": run["run_id"]}
    return {"ok": False, "error": f"最近运行状态为 {run['status']}，无需停止"}
