"""小说回填：译文写入侧写文件 tl/<lang>/translations.json，原文永不改动。"""

from __future__ import annotations

import json
from typing import Any

from tav2.adapters.novel.extract import sidecar_path


def save_translations(
    game_dir: str | Any,
    lang: str,
    translations: dict[str, str],
) -> dict[str, int]:
    """把 {unit_id: 译文} 合并写入侧写 JSON。返回统计。"""

    path = sidecar_path(game_dir, lang)
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict[str, str] = {}
    if path.exists():
        try:
            data = {str(k): str(v) for k, v in json.loads(path.read_text(encoding="utf-8")).items()}
        except (OSError, ValueError):
            data = {}
    applied = 0
    skipped = 0
    for uid, text in translations.items():
        text = (text or "").strip()
        if not text:
            skipped += 1
            continue
        data[str(uid)] = text
        applied += 1
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"applied": applied, "skipped": skipped, "unchanged": 0}
