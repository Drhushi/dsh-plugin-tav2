"""把译文回填到 tl/<语言>/*.rpy。

移植自 TranslateAgent v1 的 translate_agent/backfill.py。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tav2.adapters.renpy.tlparser import parse_tl_directory, rebuild_chunk


def backfill_machine(
    game_dir: str | Path,
    lang: str,
    dialogue_map: dict[tuple[str, str], dict[int, str]],
    string_map: dict[tuple[str, str], str],
) -> dict[str, int]:
    """直写模式：按 (文件名, 标识符) -> {行号: 译文} 与 (文件名, old) -> 译文 回填 tl。
    返回统计 {applied, skipped, unchanged}。"""

    return _apply_maps(game_dir, lang, dialogue_map, string_map)


def _apply_maps(
    game_dir: str | Path,
    lang: str,
    dialogue_map: dict[tuple[str, str], dict[int, str]],
    string_map: dict[tuple[str, str], str],
) -> dict[str, int]:
    """核心回填：把映射应用到 tl/<lang>/*.rpy，跳过无变化的文件。"""

    game_dir = Path(game_dir)
    gamedir = game_dir / "game" if (game_dir / "game").is_dir() else game_dir
    tl_dir = gamedir / "tl" / lang
    files = parse_tl_directory(game_dir, lang)
    stats = {"applied": 0, "skipped": 0, "unchanged": 0}

    for path, chunks in files:
        rel = path.relative_to(tl_dir).as_posix()
        changed = False
        new_chunks: list[list[str]] = []
        file_string_map = {
            old: translation
            for (filename, old), translation in string_map.items()
            if filename == rel
        }
        for chunk in chunks:
            say_translations: dict[int, str] | None = None
            if chunk.kind == "dialogue":
                per_say = dialogue_map.get((rel, chunk.identifier or ""))
                if per_say:
                    say_translations = per_say
            rebuilt = rebuild_chunk(chunk, say_translations, file_string_map)
            if rebuilt != chunk.raw:
                changed = True
            new_chunks.append(rebuilt)

        if not changed:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        trailing = "\n" if text.endswith("\n") else ""
        body = "\n".join(line for chunk in new_chunks for line in chunk)
        path.write_text(body + trailing, encoding="utf-8")
        stats["applied"] += 1

    return stats


APPLY_STATUSES = {"已确认", "已修改"}


def iter_applied_rows(rows: list[dict[str, Any]], force: bool = False):
    """按审校状态过滤本次应回填的行（跳过/无译文/未确认除外）。"""

    for row in rows:
        status = str(row.get("状态") or "待审")
        if status == "跳过" or (status not in APPLY_STATUSES and not force):
            continue
        translation = str(row.get("人工译文") or row.get("机器译文") or "").strip()
        if not translation:
            continue
        yield row


def backfill_review(
    game_dir: str | Path,
    lang: str,
    rows: list[dict[str, Any]],
    force: bool = False,
) -> dict[str, int]:
    """回填审校行到 tl 文件（可选审校模式的回填入口）。返回统计。"""

    dialogue_map: dict[tuple[str, str], dict[int, str]] = {}
    string_map: dict[tuple[str, str], str] = {}
    skipped = 0

    for row in rows:
        status = str(row.get("状态") or "待审")
        if status == "跳过" or (status not in APPLY_STATUSES and not force):
            skipped += 1
            continue
        translation = str(row.get("人工译文") or row.get("机器译文") or "").strip()
        if not translation:
            skipped += 1
            continue
        row_type = str(row.get("类型") or "")
        filename = str(row.get("文件") or "")
        if row_type == "dialogue":
            identifier = str(row.get("标识符") or "")
            try:
                say_index = int(row.get("序号") or 0)
            except (TypeError, ValueError):
                say_index = 0
            dialogue_map.setdefault((filename, identifier), {})[say_index] = translation
        elif row_type == "string":
            old = str(row.get("标识符") or "")
            string_map[(filename, old)] = translation

    stats = _apply_maps(game_dir, lang, dialogue_map, string_map)
    stats["skipped"] += skipped
    return stats
