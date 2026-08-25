"""世界书：条目模型、LLM 生成、关键词激活与常量上限。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from tav2.llm import BaseLLM, LLMError, extract_json_array
from tav2.prompts import WORLDBOOK_PROMPT, render
from tav2.scanning import _strip_loc, target_chars
from tav2.tokens import estimate_tokens


VALID_LORE_KINDS = ("name", "term", "setting", "lore")


@dataclass
class LoreEntry:
    kind: str = "lore"
    title: str = ""
    keywords: list[str] = field(default_factory=list)
    content: str = ""
    source_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "title": self.title,
            "keywords": self.keywords,
            "content": self.content,
            "source_refs": self.source_refs,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LoreEntry":
        return cls(
            kind=str(data.get("kind") or "lore"),
            title=str(data.get("title") or ""),
            keywords=[str(k) for k in (data.get("keywords") or [])],
            content=str(data.get("content") or ""),
            source_refs=[str(r) for r in (data.get("source_refs") or [])],
        )


def _chunk_lines(lines: list[str], max_tokens: int) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    total = 0
    for line in lines:
        cost = estimate_tokens(_strip_loc(line)) + 8
        if current and total + cost > max_tokens:
            chunks.append(current)
            current = []
            total = 0
        current.append(line)
        total += cost
    if current:
        chunks.append(current)
    return chunks


def generate_worldbook(
    llm: BaseLLM,
    cfg: dict[str, Any],
    lines: list[str],
    progress=None,
    locked_terms: list[tuple[str, str]] | None = None,
) -> list[LoreEntry]:
    """分块用 LLM 生成世界书条目。progress 为可选回调(块号, 总数)。"""

    wb_cfg = cfg.get("worldbook") or {}
    max_chars = int(wb_cfg.get("max_content_chars", 120))
    max_tokens = int(wb_cfg.get("chunk_tokens", 3200))
    reasoning = str(wb_cfg.get("reasoning_effort") or "none")
    chunks = _chunk_lines(lines, max_tokens)
    entries: list[LoreEntry] = []
    for idx, chunk in enumerate(chunks):
        if progress is not None:
            progress(idx + 1, len(chunks))
        prompt = render(
            WORLDBOOK_PROMPT.template,
            max_chars=max_chars,
        )
        constraint = ""
        if locked_terms:
            constraint = (
                "以下译名已锁定，世界书条目标题/内容涉及这些名称时必须采用、不得另译：\n"
                + "\n".join(f"  {s} → {t}" for s, t in locked_terms)
                + "\n\n"
            )
        user = constraint + "源文本片段：\n" + "\n".join(chunk)
        try:
            raw = llm.chat_json_array(prompt, user, reasoning_effort=reasoning)
        except (LLMError, ValueError, TypeError):
            continue
        for item in raw:
            entry = LoreEntry.from_dict(item)
            entry = _clean_entry(entry, max_chars)
            if entry.title and (entry.content or entry.keywords):
                entries.append(entry)
    return dedupe_entries(entries, wb_cfg)


def _clean_entry(entry: LoreEntry, max_chars: int) -> LoreEntry:
    if entry.kind not in VALID_LORE_KINDS:
        entry.kind = "lore"
    entry.title = (entry.title or "").strip()[:60]
    entry.content = (entry.content or "").strip()[:max_chars]
    entry.keywords = [str(k).strip() for k in entry.keywords if str(k).strip()]
    entry.source_refs = [str(r).strip() for r in entry.source_refs if str(r).strip()]
    return entry


def dedupe_entries(entries: list[LoreEntry], cfg: dict[str, Any]) -> list[LoreEntry]:
    """按标题/关键词去重，并按常量上限裁剪常驻条目。"""

    max_constants = int(cfg.get("max_constants", 5))
    seen_titles: set[str] = set()
    seen_keywords: set[str] = set()
    out: list[LoreEntry] = []
    constant_count = 0
    for entry in entries:
        title_key = re.sub(r"[（(].*?[)）]", "", entry.title).strip().lower()
        if not title_key or title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        kw_hit = any(k.lower() in seen_keywords for k in entry.keywords)
        if kw_hit:
            continue
        for k in entry.keywords:
            seen_keywords.add(k.lower())
        if entry.kind in ("setting", "lore") and constant_count < max_constants:
            entry.kind = "constant" if entry.kind in ("setting", "lore") else entry.kind
            constant_count += 1
        out.append(entry)
    return out


def activate(
    entries: list[dict[str, Any]],
    text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """按原文关键词词边界激活条目。返回 (常驻, 命中)。"""

    constants: list[dict[str, Any]] = []
    hits: list[dict[str, Any]] = []
    for entry in entries:
        if entry.get("kind") == "constant":
            constants.append(entry)
            continue
        for keyword in entry.get("keywords") or []:
            kw = str(keyword).strip()
            if not kw:
                continue
            if re.search(r"[A-Za-z]", kw):
                pattern = r"(?<![A-Za-z0-9_])" + re.escape(kw) + r"(?![A-Za-z0-9_])"
                if re.search(pattern, text, re.IGNORECASE):
                    hits.append(entry)
                    break
            elif kw in text:
                hits.append(entry)
                break
    return constants, hits


def coverage_report(
    entries: list[Any],
    source_files: int,
    source_lines: int,
) -> dict[str, Any]:
    """世界书覆盖率报告：条目数 / 来源文件数 / 引用文件数与告警。"""

    dicts = [e.to_dict() if hasattr(e, "to_dict") else e for e in entries]
    referenced: set[str] = set()
    for e in dicts:
        for ref in e.get("source_refs") or []:
            fn = str(ref).split(":", 1)[0].strip()
            if fn:
                referenced.add(fn)
    source_files = max(0, int(source_files))
    return {
        "entries": len(dicts),
        "source_files": source_files,
        "source_lines": int(source_lines),
        "files_referenced": len(referenced),
        "file_coverage": round(len(referenced) / source_files, 3) if source_files else 0.0,
        "warnings": coverage_warnings(len(dicts), source_files, len(referenced)),
    }


def coverage_warnings(
    entries_count: int,
    source_files: int,
    files_referenced: int,
) -> list[str]:
    """覆盖率护栏告警：条目/文件过少、引用缺失时明确提示。"""

    warnings: list[str] = []
    if source_files <= 0:
        warnings.append("来源文件数为 0，覆盖率无法计算")
    if source_files >= 5 and entries_count < max(3, source_files // 5):
        warnings.append(f"世界书条目数过少：{entries_count} 条（来源文件 {source_files} 个）")
    if files_referenced == 0:
        warnings.append("无条目带来源引用（source_refs 为空），覆盖不可审计")
    return warnings
