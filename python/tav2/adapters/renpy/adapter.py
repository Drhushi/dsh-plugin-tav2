"""Ren'Py 引擎适配器：把 tl 模板/游戏脚本归一化为 Document，并回填/校验。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tav2.adapters.base import EngineAdapter
from tav2.adapters.renpy import backfill as renpy_backfill
from tav2.adapters.renpy import characters as renpy_characters
from tav2.adapters.renpy import fonts as renpy_fonts
from tav2.adapters.renpy import templates as renpy_templates
from tav2.adapters.renpy import tlparser
from tav2.adapters.renpy.fallback_parser import RestructurerReplica
from tav2.db import source_hash
from tav2.models import Document, Scene, Unit


class RenPyAdapter(EngineAdapter):
    engine = "renpy"

    def _gamedir(self) -> Path:
        return self.game_dir / "game" if (self.game_dir / "game").is_dir() else self.game_dir

    def _source_gamedir(self) -> Path:
        """反编译源码所在 game 目录（编译版 prepare 的源码参考）。

        解析顺序：config source_dir → <游戏根>/tav2_src/game（默认约定）→ 游戏目录自身。
        散装 .rpy 游戏没有源码参考目录，自然回退到游戏目录自身，行为不变。
        """

        custom = str(self.cfg.get("source_dir") or "").strip()
        if custom:
            p = Path(custom)
            return p / "game" if (p / "game").is_dir() else p
        gamedir = self._gamedir()
        sibling = gamedir.parent / "tav2_src"
        if sibling.is_dir():
            return sibling / "game" if (sibling / "game").is_dir() else sibling
        return gamedir

    def _tl_dir(self) -> Path:
        return self._gamedir() / "tl" / self.lang

    # ------------------------------------------------------------------ prepare

    def prepare(self, sdk: str | None = None, work_dir: Path | None = None) -> dict[str, Any]:
        """生成 tl/<lang> 模板与字体补丁。

        编译版游戏（game/ 内有 .rpa/.rpi）自动走一键 prepare：
        抽脚本 → unrpyc 反编译 → staging 组装 → SDK 官方模板 → 标识符验证；
        非编译版保持原模板+字体流程。
        """

        if sdk:
            self.cfg["renpy_sdk"] = sdk
        if self._has_compiled_archives():
            from tav2.adapters.renpy import prep

            stats = dict(
                prep.cmd_prepare(
                    self.game_dir,
                    lang=self.lang,
                    sdk=sdk,
                    work_root=work_dir,
                    cfg=self.cfg,
                )
            )
            stats["template_method"] = "sdk-prep"
            return stats
        method, detail = renpy_templates.generate_templates(self._gamedir(), self.lang, self.cfg)
        stats: dict[str, Any] = {"template_method": method, "runtime": detail}
        stats.update(renpy_fonts.generate_font_patches(self.game_dir, self.lang, self.cfg))
        return stats

    def _has_compiled_archives(self) -> bool:
        """game/ 内是否存在 .rpa/.rpi 归档（编译版判定）。"""

        gamedir = self._gamedir()
        return bool(list(gamedir.glob("*.rpa")) + list(gamedir.glob("*.rpi")))

    # ------------------------------------------------------------------ extract

    def _label_map(self) -> dict[str, str]:
        """用有限解析器从游戏脚本生成 标识符 -> label 映射（失败返回空）。

        编译版游戏目录里没有松散 .rpy，自动回退到源码参考目录（tav2_src）解析。
        """

        try:
            units = RestructurerReplica().parse_game(self._source_gamedir())
        except Exception:
            return {}
        return {u.identifier: u.label or "" for u in units}

    def extract(self) -> Document:
        _files, dialogue, strings = tlparser.load_work(self.game_dir, self.lang)
        label_map = self._label_map()
        detect_branch = bool(self.cfg.get("branch", {}).get("detect", True))

        scenes: list[Scene] = []
        scenes_by_key: dict[tuple[str, str | None], Scene] = {}

        def scene_for(key: tuple[str, str | None], label: str | None) -> Scene:
            if key not in scenes_by_key:
                scene_id = f"{key[0]}::{label or 'noaddr'}"
                scenes_by_key[key] = Scene(
                    scene_id=scene_id,
                    title=f"{key[0]}#{label}" if label else key[0],
                    order=0,
                    branch=self._branch_for(label) if detect_branch else "main",
                )
                scenes.append(scenes_by_key[key])
            return scenes_by_key[key]

        for unit in sorted(dialogue, key=lambda u: (u.filename, u.linenumber)):
            label = label_map.get(unit.identifier)
            scene = scene_for((unit.filename, label), label)
            unit_translated = self._unit_translated(unit)
            for say_index, say in enumerate(unit.say_lines):
                source = (say.original_what or say.what).strip()
                if not source:
                    continue
                scene.units.append(
                    Unit(
                        unit_id=f"{unit.identifier}#{say_index}",
                        kind="dialogue",
                        source=source,
                        speaker=say.who or "",
                        scene_id=scene.scene_id,
                        extra={
                            "file": unit.filename,
                            "identifier": unit.identifier,
                            "say_index": say_index,
                            "block": True,
                            "translated": unit_translated,
                        },
                    )
                )

        string_scenes: dict[str, Scene] = {}
        for unit in sorted(strings, key=lambda u: (u.filename, u.linenumber)):
            scene = string_scenes.get(unit.filename)
            if scene is None:
                scene = Scene(
                    scene_id=f"strings::{unit.filename}",
                    title=f"strings:{unit.filename}",
                    order=0,
                    branch="main",
                )
                string_scenes[unit.filename] = scene
                scenes.append(scene)
            scene.units.append(
                Unit(
                    unit_id="S:" + source_hash(unit.old),
                    kind="string",
                    source=unit.old,
                    scene_id=scene.scene_id,
                    extra={
                        "file": unit.filename,
                        "old": unit.old,
                        "translated": unit.is_translated,
                    },
                )
            )

        for idx, scene in enumerate(scenes):
            scene.order = idx
            for unit in scene.units:
                unit.scene_id = scene.scene_id

        document = Document(
            engine="renpy",
            game_dir=str(self.game_dir),
            lang=self.lang,
            scenes=scenes,
            extra={"characters": renpy_characters.extract_characters(self._source_gamedir())},
        )
        return document

    @staticmethod
    def _unit_translated(unit: DialogueUnit) -> bool:
        """对话块是否已真正翻译：每行译文非空且与原文不同。

        模板态的 `e ""`（what 为空）视为未译，避免被跳过。
        """

        lines = [s for s in unit.say_lines if (s.original_what or s.what).strip()]
        if not lines:
            return True
        return all(
            s.what.strip() and s.original_what is not None and s.what != s.original_what
            for s in lines
        )

    @staticmethod
    def _branch_for(label: str | None) -> str:
        if not label:
            return "main"
        if "_" in label:
            head = label.split("_", 1)[0]
            if head:
                return head
        return "main"

    def scan_lines(self) -> list[str]:
        """供世界书/术语扫描用的原文行（含 [文件:行号] 前缀）。"""

        _files, dialogue, strings = tlparser.load_work(self.game_dir, self.lang)
        out: list[str] = []
        for unit in sorted(dialogue, key=lambda u: (u.filename, u.linenumber)):
            for say in unit.say_lines:
                text = (say.original_what or say.what).strip()
                if text:
                    out.append(f"[{unit.filename}:{unit.linenumber}] {text}")
        for unit in sorted(strings, key=lambda u: (u.filename, u.linenumber)):
            if unit.old.strip():
                out.append(f"[{unit.filename}:{unit.linenumber}] {unit.old}")
        return out

    # ------------------------------------------------------------------ backfill

    def backfill(self, translations: dict[str, str]) -> dict[str, int]:
        dialogue_map: dict[tuple[str, str], dict[int, str]] = {}
        string_map: dict[tuple[str, str], str] = {}
        meta = {u.unit_id: dict(u.extra) for u in self.extract().all_units()}
        for unit_id, text in translations.items():
            unit = meta.get(unit_id)
            if not unit:
                continue
            if unit_id.startswith("S:"):
                string_map[(unit["file"], unit["old"])] = text
            else:
                block = str(unit["identifier"])
                dialogue_map.setdefault((unit["file"], block), {})[
                    int(unit["say_index"])
                ] = text
        return renpy_backfill.backfill_machine(self.game_dir, self.lang, dialogue_map, string_map)

    # ------------------------------------------------------------------ verify

    def verify(self) -> dict[str, Any]:
        """校验回填：标识符集合一致、逐行标签保持。Ren'Py lint 需 SDK，默认跳过。"""

        from tav2.gates import tags_preserved

        _files, dialogue, strings = tlparser.load_work(self.game_dir, self.lang)
        doc_units = self.extract().all_units()
        blocks = {u.identifier for u in dialogue}
        expected_blocks = {
            u.extra.get("identifier") for u in doc_units if u.extra.get("block")
        }
        missing_blocks = sorted(expected_blocks - blocks)

        tag_violations: list[str] = []
        for unit in dialogue:
            for i, say in enumerate(unit.say_lines):
                source = say.original_what or say.what
                current = say.what
                if (
                    current.strip()
                    and source != current
                    and not tags_preserved(source, current)
                ):
                    tag_violations.append(f"{unit.filename}:{unit.identifier}#{i}")

        coverage = None
        gamedir = self._gamedir()
        try:
            has_source = any(
                p.suffix == ".rpy"
                and "tl" not in p.relative_to(gamedir).parts
                for p in gamedir.rglob("*.rpy")
            )
            if has_source:
                from tav2.adapters.renpy.template_diff import template_integrity

                runtime_ids = None
                for candidate in (
                    gamedir / f"ta_identifiers_{self.lang}.json",
                    self.game_dir / f"ta_identifiers_{self.lang}.json",
                ):
                    if candidate.is_file():
                        try:
                            rows = json.loads(
                                candidate.read_text(encoding="utf-8")
                            )
                            runtime_ids = {
                                row["identifier"] for row in rows
                            }
                        except (OSError, ValueError, TypeError, KeyError):
                            runtime_ids = None
                        break
                coverage = template_integrity(
                    gamedir, self.lang, patch=False, runtime_ids=runtime_ids
                )
        except Exception:
            coverage = None

        return {
            "dialogue_blocks": len(blocks),
            "expected_blocks": len(expected_blocks),
            "missing_blocks": len(missing_blocks),
            "missing_ids": missing_blocks[:20],
            "tag_violations": len(tag_violations),
            "tag_violation_samples": tag_violations[:10],
            "strings": len(strings),
            "coverage": coverage,
            "lint": "skipped（未配置 SDK 或 lint 未启用）",
        }
