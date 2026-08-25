"""小说校验：段落覆盖 0 缺失 + markdown 符号保持。"""

from __future__ import annotations

import re
from typing import Any

from tav2.adapters.novel.extract import load_document


MD_TOKEN_RE = re.compile(r"(\*\*|~~|`+|\[[^\]]*\]\([^)]*\)|^#{1,6}\s)")


def verify_novel(game_dir: str | Any, lang: str = "chinese") -> dict[str, Any]:
    document = load_document(game_dir, lang)
    units = document.all_units()
    missing_ids = [u.unit_id for u in units if not u.extra.get("translated")]
    violations = _markdown_violations(units)
    return {
        "dialogue_blocks": len(units),
        "missing_blocks": len(missing_ids),
        "missing_ids": missing_ids[:20],
        "markdown_violations": len(violations),
        "markdown_samples": violations[:10],
        "strings": 0,
        "lint": "sidecar-json",
    }


def _markdown_violations(units: list[Any]) -> list[str]:
    out: list[str] = []
    for u in units:
        if not u.extra.get("translated"):
            continue
        if u.extra.get("format") not in ("md", "markdown"):
            continue
        src_tokens = sorted(set(MD_TOKEN_RE.findall(u.source)))
        if not src_tokens:
            continue
        dst_tokens = sorted(set(MD_TOKEN_RE.findall(u.extra.get("translation") or "")))
        if src_tokens != dst_tokens:
            out.append(u.unit_id)
    return out
