"""小说引擎适配器：复用 EngineAdapter 协议，双阶段核心零改动。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tav2.adapters.base import EngineAdapter
from tav2.adapters.novel import backfill as novel_backfill
from tav2.adapters.novel import extract as novel_extract
from tav2.adapters.novel import verify as novel_verify
from tav2.models import Document


class NovelAdapter(EngineAdapter):
    engine = "novel"

    def prepare(self, sdk: str | None = None, work_dir: Path | None = None) -> dict[str, Any]:
        """小说无需模板/解包；直接返回就绪状态。"""

        return {"template_method": "novel-native", "runtime": None}

    def extract(self) -> Document:
        return novel_extract.load_document(self.game_dir, self.lang)

    def backfill(self, translations: dict[str, str]) -> dict[str, int]:
        return novel_backfill.save_translations(self.game_dir, self.lang, translations)

    def verify(self) -> dict[str, Any]:
        return novel_verify.verify_novel(self.game_dir, self.lang)

    def scan_lines(self) -> list[str]:
        return novel_extract.scan_lines(self.game_dir, self.lang)
