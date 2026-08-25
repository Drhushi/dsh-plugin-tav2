"""引擎适配器协议：核心只认该协议，不感知引擎细节。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from tav2.models import Document


class EngineAdapter(ABC):
    """引擎适配器协议。

    生命周期：prepare()（解包/模板/字体）→ extract()（产出 Document）
    → backfill(translations)（写回引擎格式）→ verify()（标识符/标签完整性）。
    """

    engine: str

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.game_dir = Path(cfg.get("game_dir") or "")
        if not self.game_dir.exists():
            raise FileNotFoundError(f"game_dir 不存在：{self.game_dir}")
        self.lang = str(cfg.get("lang") or "chinese")

    @abstractmethod
    def prepare(self, sdk: str | None = None, work_dir: Path | None = None) -> dict[str, Any]:
        """准备翻译工程：解包/反编译/生成模板/字体补丁。返回统计信息。"""

    @abstractmethod
    def extract(self) -> Document:
        """把引擎文本归一化为 Document（场景树 + 单元）。"""

    @abstractmethod
    def backfill(self, translations: dict[str, str]) -> dict[str, int]:
        """把 {unit_id: 译文} 写回引擎格式。返回统计。"""

    @abstractmethod
    def verify(self) -> dict[str, Any]:
        """校验回填结果：标识符完整性/标签保持/引擎 lint。返回报告。"""
