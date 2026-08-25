"""质量门禁：标签保持、术语审计、反翻译腔、一致性审计。"""

from __future__ import annotations

import re
from typing import Any


_TAG_RE = re.compile(r"\{[^{}\n]*\}|\[[^\]\n]+\]")


def renpy_tokens(text: str) -> tuple[set[str], int]:
    """提取 Ren'Py 文本标签与插值；以及 %% / {{ / }} / \\n 转义计数。"""

    tags = set(re.findall(r"\{[^{}\n]*\}", text))
    tags |= set(re.findall(r"\[[^\]\n]+\]", text))
    escapes = text.count("%%") + text.count("{{") + text.count("}}") + text.count("\\n")
    return tags, escapes


def tags_preserved(source: str, translation: str) -> bool:
    """校验译文是否原样保留源文本中的 Ren'Py 标签、插值与转义。

    {#tag} 是确定性可恢复的临时标签，不强制 LLM 携带（回填时自动补回）。
    """

    src_tags, src_esc = renpy_tokens(source)
    if not src_tags and src_esc == 0:
        return True
    dst_tags, dst_esc = renpy_tokens(translation)
    required = {t for t in src_tags if not t.startswith("{#")}
    return bool(required.issubset(dst_tags)) and dst_esc >= src_esc


#: 反翻译腔禁词（无原文对应时禁止出现；原文确有对应则允许）
ANTI_TRANSLATIONESE = (
    "然而",
    "仿佛",
    "一丝",
    "不禁",
    "不禁令",
    "不由得",
    "似乎",
    "这般",
    "那般",
    "说道",
    "如此这般",
    "只见",
    "顿时",
    "刹那间",
    "旋即",
)


def banned_word_hits(text: str) -> list[str]:
    """返回译文命中的反翻译腔禁词（供报告，不阻塞）。"""

    return [w for w in ANTI_TRANSLATIONESE if w in text]


def term_audit(
    translations: dict[str, str],
    sources: dict[str, str],
    locked_terms: list[dict[str, str]],
) -> list[dict[str, str]]:
    """术语审计：源文本命中锁定术语时，译文必须包含其译名。返回漏用清单。"""

    misses: list[dict[str, str]] = []
    for term in locked_terms:
        source = str(term.get("source") or "").strip()
        target = str(term.get("target") or "").strip()
        if len(source) < 2 or not target:
            continue
        pattern = (
            re.compile(r"(?<![A-Za-z0-9_])" + re.escape(source) + r"(?![A-Za-z0-9_])")
            if re.search(r"[A-Za-z]", source)
            else None
        )
        for unit_id, translation in translations.items():
            src_text = sources.get(unit_id, "")
            hit = bool(pattern.search(src_text)) if pattern else source in src_text
            if hit and target not in translation:
                misses.append(
                    {"unit_id": unit_id, "term": source, "target": target, "translation": translation}
                )
    return misses


def consistency_audit(
    translations: dict[str, str],
    sources: dict[str, str],
) -> list[dict[str, Any]]:
    """一致性审计：同源句不同译文。返回冲突组。"""

    groups: dict[str, dict[str, str]] = {}
    for unit_id, translation in translations.items():
        src = sources.get(unit_id, "")
        if not src:
            continue
        groups.setdefault(src, {})[unit_id] = translation
    conflicts: list[dict[str, Any]] = []
    for source, items in groups.items():
        if len({v for v in items.values()}) > 1:
            conflicts.append({"source": source, "variants": items})
    return conflicts
