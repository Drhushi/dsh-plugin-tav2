"""Ren'Py 中文字体补丁：names.rpy / style.rpy / 字体文件拷贝。

v1 版精简实现：不做字体库下载与管理，只做可配置的补丁生成。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tav2.adapters.renpy.renpy_compat import quote_unicode


def _tl_dir(game_dir: Path, lang: str) -> Path:
    gamedir = game_dir / "game" if (game_dir / "game").is_dir() else game_dir
    return gamedir / "tl" / lang


def write_names_rpy(game_dir: Path, lang: str, names: dict[str, str]) -> int:
    """写出 names.rpy：角色显示名 old/new 字符串条目。返回条目数。"""

    if not names:
        return 0
    tl_dir = _tl_dir(game_dir, lang)
    tl_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"translate {lang} strings:", ""]
    for old, new in names.items():
        lines.append(f'    old "{quote_unicode(old)}"')
        lines.append(f'    new "{quote_unicode(new)}"')
        lines.append("")
    (tl_dir / "names.rpy").write_text("\n".join(lines), encoding="utf-8")
    return len(names)


def write_style_rpy(game_dir: Path, lang: str, cfg: dict[str, Any]) -> int:
    """写出 style.rpy：translate <lang> python 覆盖 gui 字体。返回覆盖数。"""

    fonts_cfg = cfg.get("fonts") or {}
    overrides: dict[str, str] = {}
    if fonts_cfg.get("gui"):
        overrides["gui.text_font"] = str(fonts_cfg["gui"])
    if fonts_cfg.get("name"):
        overrides["gui.name_text_font"] = str(fonts_cfg["name"])
    if fonts_cfg.get("interface"):
        overrides["gui.interface_text_font"] = str(fonts_cfg["interface"])
    if fonts_cfg.get("default") and not overrides:
        overrides["gui.text_font"] = str(fonts_cfg["default"])
        overrides["gui.name_text_font"] = str(fonts_cfg["default"])
        overrides["gui.interface_text_font"] = str(fonts_cfg["default"])
    if not overrides:
        return 0
    tl_dir = _tl_dir(game_dir, lang)
    tl_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"translate {lang} python:", ""]
    for var, font in overrides.items():
        lines.append(f'    {var} = "{font}"')
        lines.append("")
    (tl_dir / "style.rpy").write_text("\n".join(lines), encoding="utf-8")
    return len(overrides)


def copy_fonts(game_dir: Path, cfg: dict[str, Any]) -> int:
    """把本地字体目录中的字体文件拷贝到 tl/<lang>/font/。返回拷贝数。"""

    fonts_dir = str((cfg.get("fonts") or {}).get("dir") or "").strip()
    if not fonts_dir or not Path(fonts_dir).is_dir():
        return 0
    tl_dir = _tl_dir(game_dir, cfg.get("lang") or "chinese")
    out_dir = tl_dir / "font"
    out_dir.mkdir(parents=True, exist_ok=True)
    copied = 0
    import shutil

    for src in sorted(Path(fonts_dir).rglob("*")):
        if src.is_file() and src.suffix.lower() in (".ttf", ".otf", ".ttc"):
            dst = out_dir / src.name
            if not dst.exists():
                shutil.copy2(src, dst)
                copied += 1
    return copied


def generate_font_patches(game_dir: Path, lang: str, cfg: dict[str, Any]) -> dict[str, int]:
    """生成全部字体补丁。返回统计。"""

    if not (cfg.get("fonts") or {}).get("enabled", True):
        return {"names": 0, "style": 0, "fonts_copied": 0}
    names = (cfg.get("fonts") or {}).get("names") or {}
    return {
        "names": write_names_rpy(game_dir, lang, dict(names)),
        "style": write_style_rpy(game_dir, lang, cfg),
        "fonts_copied": copy_fonts(game_dir, cfg),
    }
