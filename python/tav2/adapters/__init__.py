"""引擎适配器注册表。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tav2.adapters.base import EngineAdapter


def get_adapter(cfg: dict[str, Any]) -> "EngineAdapter":
    """按配置选择适配器：engine=renpy（默认）/ novel（二期占位）。"""

    engine = str(cfg.get("engine") or "renpy").lower()
    if engine == "renpy":
        from tav2.adapters.renpy.adapter import RenPyAdapter

        return RenPyAdapter(cfg)
    if engine == "novel":
        from tav2.adapters.novel.adapter import NovelAdapter

        return NovelAdapter(cfg)
    raise ValueError(f"未知引擎适配器：{engine}")
