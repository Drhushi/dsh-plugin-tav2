"""轻量 token 估算（用于批大小与摘要预算控制，不需要联网分词）。"""

from __future__ import annotations

import re


WORD_RE = re.compile(r"[A-Za-z0-9_]+")
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def estimate_tokens(text: str) -> int:
    """粗略估计 token 数：英文单词约 1.3 token/词，中日韩字符按 1 token/字。"""

    words = len(WORD_RE.findall(text))
    cjk = len(CJK_RE.findall(text))
    other = len(text) - sum(len(m) for m in WORD_RE.findall(text)) - cjk
    return int(words * 1.3 + cjk + other * 0.25) + 1
