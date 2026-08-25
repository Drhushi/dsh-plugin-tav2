"""滚动剧情摘要：基于已有摘要增量扩展。"""

from __future__ import annotations

from typing import Any

from tav2.llm import BaseLLM
from tav2.prompts import SUMMARY_PROMPT, render


def update_summary(
    llm: BaseLLM,
    cfg: dict[str, Any],
    summary: str,
    new_text: str,
) -> str:
    words = int(cfg.get("context", {}).get("summary_tokens", 500)) // 2
    prompt = render(
        SUMMARY_PROMPT.template,
        words=words,
        summary=summary or "（暂无）",
        new_text=new_text,
    )
    return (llm.chat("你是视觉小说剧情的摘要助手。", prompt) or "").strip()
