"""译前快筛：本地正则提取术语/人名候选 + 语言护栏 + 上下文样本。"""

from __future__ import annotations

import re
from typing import Any


SOURCE_LANGUAGE_GUARD_THRESHOLD = 0.2

CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
KANA_RE = re.compile(r"[\u3040-\u30ff]")

_LOC_RE = re.compile(r"^\[([^\]]+):(\d+)\]\s?(.*)$")

_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
        "with", "from", "by", "as", "is", "are", "was", "were", "be", "been", "being",
        "it", "its", "this", "that", "these", "those", "i", "you", "he", "she", "we",
        "they", "my", "your", "his", "her", "our", "their", "me", "him", "us", "them",
        "not", "no", "yes", "so", "if", "then", "than", "when", "what", "who", "how",
        "will", "would", "can", "could", "should", "shall", "may", "might", "must",
        "have", "has", "had", "do", "does", "did", "just", "like", "well", "okay",
        "oh", "ah", "um", "uh", "hey", "hello", "hi", "thanks", "thank", "please",
        "really", "very", "much", "many", "some", "any", "all", "one", "two", "three",
        "man", "woman", "guy", "girl", "boy", "thing", "things", "something", "nothing",
        "right", "ok", "yeah", "yep", "nope", "sure", "fine", "good", "bad", "big",
        "small", "know", "think", "see", "look", "want", "need", "get", "go", "come",
        "make", "take", "say", "said", "tell", "told", "ask", "asked", "back", "still",
        "even", "maybe", "always", "never", "also", "here", "there", "now", "then",
    }
)

# 额外默认停用词（报告噪音实测：time/more/less/day 等通用词高频入选）
_EXTRA_STOPWORDS = frozenset(
    {
        "time", "times", "more", "less", "day", "days", "week", "weeks", "month",
        "months", "year", "years", "minute", "minutes", "hour", "hours", "moment",
        "moments", "today", "tonight", "tomorrow", "yesterday", "people", "someone",
        "everyone", "anyone", "everything", "little", "lot", "lots", "stuff", "gonna",
        "wanna", "kinda", "sorta", "hmm", "huh", "mmm", "ugh", "phew",
    }
)

_ALL_STOPWORDS = _STOPWORDS | _EXTRA_STOPWORDS

_ALLCAPS_RE = re.compile(r"\b[A-Z]{2,}(?:[-–][A-Z0-9]+)*\b")


def target_chars(text: str) -> int:
    return len(CJK_RE.findall(text)) + len(KANA_RE.findall(text))


def target_language_ratio(lines: list[str], lang: str) -> float:
    """目标语言字符占比（chinese 按 CJK 计；其余语言按同一套 CJK 兜底）。"""

    total_chars = 0
    target_chars_count = 0
    for line in lines:
        body = _strip_loc(line)
        total_chars += len(body)
        target_chars_count += target_chars(body)
    if total_chars == 0:
        return 0.0
    return target_chars_count / total_chars


def check_source_language(lines: list[str], lang: str) -> None:
    """语言护栏：目标语言字符占比超过阈值时中止。"""

    ratio = target_language_ratio(lines, lang)
    if ratio > SOURCE_LANGUAGE_GUARD_THRESHOLD:
        raise ValueError(
            f"输入疑似读到了 tl 译文：目标语言字符占比 {ratio:.0%} "
            f"超过阈值 {SOURCE_LANGUAGE_GUARD_THRESHOLD:.0%}。请确认输入为原版源文本。"
        )


def _strip_loc(line: str) -> str:
    m = _LOC_RE.match(line.strip())
    return m.group(3) if m else line.strip()


def _loc(line: str) -> str:
    m = _LOC_RE.match(line.strip())
    return f"{m.group(1)}:{m.group(2)}" if m else ""


def _name_candidates(text: str, stopwords: frozenset[str] = _ALL_STOPWORDS) -> list[str]:
    """提取专名候选：首字母大写的词/词组、全大写词。"""

    out: list[str] = []
    words = re.findall(r"[A-Za-z][A-Za-z0-9'_-]*", text)
    i = 0
    while i < len(words):
        w = words[i]
        if _ALLCAPS_RE.fullmatch(w) and len(w) >= 2:
            out.append(w)
            i += 1
            continue
        if w[:1].isupper() and w.lower() not in stopwords:
            seq = [w]
            j = i + 1
            while j < len(words) and words[j][:1].isupper():
                seq.append(words[j])
                j += 1
            joined = " ".join(seq)
            if len(seq) == 1 and len(seq[0]) < 3:
                i = j
                continue
            if len(seq) == 1:
                out.append(seq[0])
            else:
                out.append(joined)
                out.append(seq[0])
            i = j
            continue
        i += 1
    return out


def _term_candidates(text: str, stopwords: frozenset[str] = _ALL_STOPWORDS) -> list[str]:
    """提取术语候选：出现 ≥2 次的长度 ≥4 的词。"""

    words = re.findall(r"[A-Za-z][A-Za-z0-9'-]{3,}", text)
    seen: set[str] = set()
    out: list[str] = []
    for w in words:
        low = w.lower()
        if low in stopwords or low in seen:
            continue
        seen.add(low)
        out.append(w)
    return out


def scan_lines(
    lines: list[str],
    cfg: dict[str, Any],
) -> list[dict[str, Any]]:
    """扫描原文行，返回候选列表 [{source, kind, frequency, samples}]。

    kind: name（专名）/ term（术语）/ allcaps。
    """

    scan_cfg = cfg.get("scan") or {}
    min_frequency = int(scan_cfg.get("min_frequency", 6))
    max_items = int(scan_cfg.get("max_items", 500))
    window = int(scan_cfg.get("context_window_lines", 2))
    max_samples = int(scan_cfg.get("max_context_samples", 3))
    stopwords = _ALL_STOPWORDS | frozenset(scan_cfg.get("stopwords") or [])

    if scan_cfg.get("source_language_guard", True):
        check_source_language(lines, str(cfg.get("lang") or "chinese"))

    counts: dict[tuple[str, str], list[str]] = {}
    for idx, line in enumerate(lines):
        loc = _loc(line)
        body = _strip_loc(line)
        for cand in _name_candidates(body, stopwords):
            counts.setdefault((cand, "name"), []).append(idx)
        for cand in _term_candidates(body, stopwords):
            counts.setdefault((cand, "term"), []).append(idx)
        for cand in _ALLCAPS_RE.findall(body):
            counts.setdefault((cand, "allcaps"), []).append(idx)

    candidates: list[dict[str, Any]] = []
    for (source, kind), indexes in counts.items():
        freq = len(indexes)
        if kind in ("name", "allcaps"):
            threshold = max(2, min_frequency // 2)
        else:
            threshold = min_frequency
        if freq < threshold:
            continue
        samples: list[str] = []
        for pos in indexes[: max_samples * 2]:
            start = max(0, pos - window)
            end = min(len(lines), pos + window + 1)
            snippet = " | ".join(_strip_loc(lines[k]) for k in range(start, end))
            if snippet not in samples:
                samples.append(snippet)
            if len(samples) >= max_samples:
                break
        candidates.append(
            {
                "source": source,
                "kind": kind,
                "frequency": freq,
                "samples": samples,
            }
        )

    candidates.sort(key=lambda c: (-c["frequency"], c["source"]))
    return candidates[:max_items]
