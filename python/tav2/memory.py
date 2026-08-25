"""混合检索：滚动摘要 + 世界书关键词激活 + 锁定术语 + TM few-shot + 可选向量兜底。"""

from __future__ import annotations

import json
from dataclasses import asdict
from dataclasses import dataclass, field
from typing import Any

from tav2.llm import embed_texts
from tav2.models import Scene, UnderstandingRecord
from tav2.scanning import target_chars
from tav2.worldbook import activate


@dataclass
class MemoryPack:
    summary: str = ""
    main_summary: str = ""  # 分支场景携带的主线摘要（合并点上下文）
    constants: list[dict[str, Any]] = field(default_factory=list)
    lore_hits: list[dict[str, Any]] = field(default_factory=list)
    glossary: list[tuple[str, str, str]] = field(default_factory=list)
    few_shot: list[tuple[str, str]] = field(default_factory=list)
    recent_understandings: list[UnderstandingRecord] = field(default_factory=list)
    vector_hits: list[dict[str, Any]] = field(default_factory=list)


def build_memory_pack(
    db: Any,
    llm: Any,
    cfg: dict[str, Any],
    scene: Scene,
    unit_sources: list[str],
    main_branch: str | None = None,
) -> MemoryPack:
    """为场景组装记忆包。"""

    main_branch = main_branch or "main"
    pack = MemoryPack()
    pack.summary = db.get_summary(scene.branch)
    if scene.branch != main_branch:
        # 合并点/分支场景：额外携带主线摘要，保证分支前文上下文不丢
        pack.main_summary = db.get_summary(main_branch)
    worldbook = db.load_worldbook()
    joined = "\n".join(unit_sources)
    pack.constants, pack.lore_hits = activate(worldbook, joined)

    locked = db.locked_terms()
    pack.glossary = [
        (t["source"], t["target"], t.get("category") or "")
        for t in locked
        if _term_hits(t["source"], joined)
    ]
    pack.recent_understandings = db.recent_understandings(scene.branch, limit=3)
    pack.few_shot = _few_shot(db, unit_sources, int(cfg.get("context", {}).get("few_shot_pairs", 6)))

    if cfg.get("memory", {}).get("vector_enabled"):
        candidates = _index_candidates(worldbook, pack.recent_understandings)
        pack.vector_hits = _vector_hits(cfg, llm, candidates, unit_sources)
    return pack


def _term_hits(source: str, joined: str) -> bool:
    import re

    if not source or len(source) < 2:
        return False
    if re.search(r"[A-Za-z]", source):
        return (
            re.search(
                r"(?<![A-Za-z0-9_])" + re.escape(source) + r"(?![A-Za-z0-9_])",
                joined,
            )
            is not None
        )
    return source in joined


def _few_shot(db: Any, unit_sources: list[str], max_pairs: int) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for source in unit_sources:
        translation = db.tm_get(source)
        if translation and translation != source:
            pairs.append((source, translation))
        if len(pairs) >= max_pairs:
            break
    return pairs


def _vector_hits(
    cfg: dict[str, Any],
    llm: Any,
    candidates: list[dict[str, Any]],
    unit_sources: list[str],
) -> list[dict[str, Any]]:
    """向量检索兜底：对索引候选（世界书 + 最近理解记录）做 top-k 召回。

    embedding 未配置/调用失败时静默降级返回 []。
    """

    if not candidates or not unit_sources:
        return []

    def embed(texts: list[str]) -> list[list[float]]:
        try:
            return embed_texts(cfg, texts) or []
        except Exception:
            return []

    query_vecs = embed(["\n".join(unit_sources)])
    if not query_vecs:
        return []
    index = build_vector_index(candidates, embed)
    if not index:
        return []
    top_k = int(cfg.get("memory", {}).get("top_k", 3))
    return vector_search(query_vecs[0], index, top_k)


def _index_candidates(
    worldbook: list[dict[str, Any]],
    recent_understandings: list[Any],
) -> list[dict[str, Any]]:
    """索引候选 = 世界书条目 + 最近理解记录（序列化为可检索文本）。"""

    candidates: list[dict[str, Any]] = []
    for entry in worldbook:
        candidates.append(
            {
                "kind": str(entry.get("kind") or "lore"),
                "title": str(entry.get("title") or ""),
                "keywords": list(entry.get("keywords") or []),
                "content": str(entry.get("content") or ""),
                "source_refs": list(entry.get("source_refs") or []),
            }
        )
    for rec in recent_understandings:
        text = json.dumps(
            {"state": rec.scene_state, "threads": [asdict(t) for t in rec.threads]},
            ensure_ascii=False,
        )
        candidates.append(
            {
                "kind": "understanding",
                "title": f"理解:{rec.scene_id}",
                "keywords": [],
                "content": text,
                "source_refs": [],
            }
        )
    return candidates


def build_vector_index(
    entries: list[dict[str, Any]],
    embed_fn,
) -> list[tuple[dict[str, Any], list[float]]]:
    """把条目批量向量化，返回 [(entry, vec)]（失败/空向量条目跳过）。"""

    if not entries:
        return []
    texts = [
        str(e.get("content") or "") or str(e.get("title") or "")
        for e in entries
    ]
    vecs = embed_fn(texts)
    if not vecs:
        return []
    out: list[tuple[dict[str, Any], list[float]]] = []
    for entry, vec in zip(entries, vecs):
        if vec:
            out.append((entry, vec))
    return out


def vector_search(
    query_vec: list[float],
    index: list[tuple[dict[str, Any], list[float]]],
    top_k: int,
    min_score: float = 0.5,
) -> list[dict[str, Any]]:
    """余弦相似度 top-k 召回（高于 min_score 才保留）。"""

    scored: list[tuple[float, dict[str, Any]]] = []
    for entry, vec in index:
        score = _cosine(query_vec, vec)
        if score > min_score:
            scored.append((score, entry))
    scored.sort(key=lambda x: -x[0])
    return [entry for _score, entry in scored[: max(0, top_k)]]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
