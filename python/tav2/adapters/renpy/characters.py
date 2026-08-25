"""说话人识别：从反编译源码提取角色定义（who 简写 → 显示名）。

移植自 TranslateAgent v1 的 translate_agent/characters.py（保留核心逻辑）。
"""

from __future__ import annotations

import re
from pathlib import Path


CHAR_RE = re.compile(
    r"(?:^|\n)\s*(?:define|\$)\s+(\w+)\s*=\s*Character\(\s*"
    r'(?:"([^"]*)"|_\("([^"]*)"\)|None|game_state\.player_name)'
)
TEMP_TAG_IN_NAME_RE = re.compile(r"\{#[^}]*\}")


def extract_characters(game_dir: str | Path) -> dict[str, str]:
    """扫描反编译脚本中的 Character 定义，返回 {who 简写: 显示名}。"""

    game_dir = Path(game_dir)
    gamedir = game_dir / "game" if (game_dir / "game").is_dir() else game_dir
    mapping: dict[str, str] = {}
    for p in sorted(gamedir.rglob("*.rpy")):
        if "tl" in p.relative_to(gamedir).parts:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in CHAR_RE.finditer(text):
            who = m.group(1)
            name = m.group(2) or m.group(3) or ""
            if "game_state.player_name" in m.group(0):
                name = "玩家"
            elif not name and "None" in m.group(0):
                name = "旁白"
            if who and name:
                mapping[who] = name
    return mapping


def clean_name(name: str) -> str:
    return TEMP_TAG_IN_NAME_RE.sub("", name or "").strip()
