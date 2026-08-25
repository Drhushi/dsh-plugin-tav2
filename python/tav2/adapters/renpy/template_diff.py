"""模板完整性：反编译源码 vs 官方模板 diff、缺失块补入、非常规语句审计。

解决官方 Ren'Py translate 模板在「脱模」游戏上漏译非常规对话/选项的问题：
- 反编译源码单元集（RestructurerReplica，含跳过审计）与模板标识符 diff；
- 模板缺失的对话/选项块按 Ren'Py 标识符算法补写回 tl/<lang>（运行时 lint 兜底验证）；
- 菜单选项字符串补齐到 strings 段；其余缺失字符串默认仅审计（可配置开启）；
- 输出模板-vs-源码单元数与膨胀率，供成本基线说明。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from tav2.adapters.renpy.fallback_parser import RestructurerReplica
from tav2.adapters.renpy.prep import collect_template_ids
from tav2.adapters.renpy.renpy_compat import quote_unicode
from tav2.adapters.renpy.renpy_models import StringUnit
from tav2.adapters.renpy.templates import scan_fallback_strings
from tav2.adapters.renpy.tlparser import parse_tl_file

TEMPLATE_PSEUDO_IDS = {"strings", "python"}

# 非常规语句审计模式（文件/行级；dialogue 补入走 replica，其余只审计提醒）
NONSTANDARD_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("renpy.say", re.compile(r"\brenpy\.say\s*\(")),
    ("renpy.input", re.compile(r"\brenpy\.input\s*\(")),
    ("renpy.notify", re.compile(r"\brenpy\.notify\s*\(")),
    ("ui.text", re.compile(r"\bui\.text\s*\(")),
    ("call screen", re.compile(r"^\s*call\s+screen\b")),
    ("extend", re.compile(r"^\s*extend\b")),
    ("nvl block", re.compile(r"^\s*nvl\s*:")),
)


def _parse_source(game_dir: Path):
    """解析反编译源码：返回 (对话单元, 跳过审计, 菜单选项)。"""

    replica = RestructurerReplica()
    units = replica.parse_game(game_dir)
    return units, list(replica.skipped), list(replica.menu_choices)


def _dialogue_ids(tl_dir: Path, lang: str) -> set[str]:
    ids = collect_template_ids(tl_dir, lang)
    return {
        i
        for i in ids
        if i not in TEMPLATE_PSEUDO_IDS and not i.startswith("style ")
    }


def _template_string_olds(tl_dir: Path, lang: str) -> set[str]:
    olds: set[str] = set()
    if not tl_dir.exists():
        return olds
    for path in tl_dir.rglob("*.rpy"):
        for chunk in parse_tl_file(path, lang):
            if chunk.kind != "strings":
                continue
            for pair in chunk.pairs:
                if pair.old:
                    olds.add(pair.old)
    return olds


def _render_dialogue_block(lang: str, unit: Any) -> list[str]:
    lines = [f"translate {lang} {unit.identifier}:", ""]
    lines.append(f"    # {unit.filename}:{unit.linenumber}")
    for raw in unit.raw_statements:
        lines.append(f"    # {raw}")
        lines.append(f"    {raw}")
    for say in unit.say_lines:
        src = say.original_what or say.what
        lines.append(f"    # {say.raw}")
        lines.append(f"    {say.render(src)}")
    lines.append("")
    return lines


def patch_missing_dialogue(
    tl_dir: Path, lang: str, source_units: list[Any], missing_ids: list[str]
) -> tuple[list[str], list[str]]:
    """把源码有、模板无的对话块补写进 tl/<lang>（块体保持原文，未译即显示原文）。"""

    by_id = {u.identifier: u for u in source_units}
    groups: dict[str, list[Any]] = {}
    for identifier in sorted(missing_ids):
        unit = by_id.get(identifier)
        if unit is None:
            continue
        groups.setdefault(unit.filename, []).append(unit)
    added: list[str] = []
    written: list[str] = []
    for filename, units in groups.items():
        target = tl_dir / filename
        if target.suffix == ".rpym":
            target = target.with_suffix(".rpy")
        target.parent.mkdir(parents=True, exist_ok=True)
        blocks: list[str] = []
        for unit in units:
            blocks.extend(_render_dialogue_block(lang, unit))
        text = (
            target.read_text(encoding="utf-8", errors="replace")
            if target.exists()
            else ""
        )
        if text and not text.endswith("\n"):
            text += "\n"
        target.write_text(text + "\n".join(blocks), encoding="utf-8")
        added.extend(u.identifier for u in units)
        written.append(target.relative_to(tl_dir).as_posix())
    return added, written


def _append_string_pairs(tl_dir: Path, lang: str, units: list[StringUnit]) -> int:
    target = tl_dir / "strings.rpy"
    target.parent.mkdir(parents=True, exist_ok=True)
    text = (
        target.read_text(encoding="utf-8", errors="replace")
        if target.exists()
        else ""
    )
    blocks: list[str] = []
    for unit in units:
        blocks.append("")
        blocks.append(f"    # {unit.filename}:{unit.linenumber}")
        blocks.append(f'    old "{quote_unicode(unit.old)}"')
        blocks.append('    new ""')
    if not text.strip():
        target.write_text(
            f"translate {lang} strings:\n" + "\n".join(blocks) + "\n",
            encoding="utf-8",
        )
        return len(units)
    lines = text.split("\n")
    header_re = re.compile(rf"^translate\s+{re.escape(lang)}\s+strings:")
    for idx, line in enumerate(lines):
        if header_re.match(line):
            lines[idx + 1 : idx + 1] = blocks
            break
    else:
        lines += ["", f"translate {lang} strings:"] + blocks
    target.write_text("\n".join(lines), encoding="utf-8")
    return len(units)


def _audit_nonstandard(game_dir: Path, limit: int = 200) -> dict[str, Any]:
    hits: list[dict[str, Any]] = []
    for path in sorted(game_dir.rglob("*.rpy")):
        if "tl" in path.relative_to(game_dir).parts:
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").split("\n")
        except OSError:
            continue
        rel = path.relative_to(game_dir).as_posix()
        for lineno, line in enumerate(lines, 1):
            for kind, pattern in NONSTANDARD_PATTERNS:
                if pattern.search(line):
                    hits.append(
                        {
                            "file": rel,
                            "line": lineno,
                            "kind": kind,
                            "text": line.strip()[:120],
                        }
                    )
    counts: dict[str, int] = {}
    for h in hits:
        counts[h["kind"]] = counts.get(h["kind"], 0) + 1
    return {"patterns": counts, "total_hits": len(hits), "samples": hits[:limit]}


def template_integrity(
    game_dir: Path,
    lang: str,
    patch: bool = True,
    patch_strings: bool = False,
    audit_limit: int = 200,
    runtime_ids: set[str] | None = None,
) -> dict[str, Any]:
    """源码 vs 模板完整性报告；patch=True 时把缺失对话/选项补入 tl 模板。

    runtime_ids 为运行时 lint dump 的权威标识符集（编译版 prepare 提供）：
    「必须补入」= 运行时缺失（runtime - template）且源码解析能提供内容的块；
    replica 解析出的伪标识符（源码有、运行时无）仅记录，不补入，避免成本膨胀。
    未提供 runtime_ids（散装/无 lint）时退回源码-vs-模板口径。
    """

    game_dir = Path(game_dir)
    tl_dir = game_dir / "tl" / lang

    source_units, skipped, menu_choices = _parse_source(game_dir)
    source_ids = {u.identifier for u in source_units}
    template_ids = _dialogue_ids(tl_dir, lang)
    by_id = {u.identifier: u for u in source_units}

    if runtime_ids is not None:
        runtime_ids = set(runtime_ids)
        missing = sorted(runtime_ids - template_ids)
        extra = sorted(template_ids - runtime_ids)
        patchable = [i for i in missing if i in by_id]
        unpatchable = [i for i in missing if i not in by_id]
    else:
        missing = sorted(source_ids - template_ids)
        extra = sorted(template_ids - source_ids)
        patchable = missing
        unpatchable = []

    added_dialogue: list[str] = []
    patched_files: list[str] = []
    if patch and patchable:
        added_dialogue, patched_files = patch_missing_dialogue(
            tl_dir, lang, source_units, patchable
        )

    # 字符串层：菜单选项必补（用户可见），其余 _()/_p() 默认审计、可配置开启补入
    scan_strings = scan_fallback_strings(game_dir)
    choices: list[StringUnit] = [
        StringUnit(old=text, new="", filename=file, linenumber=line)
        for file, line, text in menu_choices
    ]
    template_olds = _template_string_olds(tl_dir, lang)
    choice_olds = {c.old for c in choices}
    missing_choices = sorted(choice_olds - template_olds)
    other_olds = {s.old for s in scan_strings} - template_olds - choice_olds
    added_strings: list[str] = []
    if patch and (patch_strings or missing_choices):
        patchable = [c for c in choices if c.old in missing_choices]
        if patch_strings:
            patchable += [s for s in scan_strings if s.old in other_olds]
        if patchable:
            _append_string_pairs(tl_dir, lang, patchable)
            added_strings = [u.old for u in patchable]

    source_n = len(source_units)
    template_n = len(template_ids)
    replica_extra = sorted(source_ids - set(runtime_ids)) if runtime_ids is not None else []
    return {
        "source_dialogue_units": source_n,
        "template_dialogue_blocks": template_n,
        "template_inflation_units": round(template_n / source_n, 2) if source_n else None,
        "missing_from_template": missing,
        "unpatchable_runtime_blocks": unpatchable,
        "replica_extra_ids": replica_extra,
        "added_from_source": added_dialogue,
        "patched_files": patched_files,
        "extra_in_template": extra,
        "missing_strings": len(missing_choices) + len(other_olds),
        "missing_choice_strings": len(missing_choices),
        "missing_choice_samples": missing_choices[:20],
        "missing_other_strings": len(other_olds),
        "added_strings": len(added_strings),
        "skipped_source_statements": len(skipped),
        "skipped_samples": skipped[:audit_limit],
        "nonstandard": _audit_nonstandard(game_dir, audit_limit),
    }
