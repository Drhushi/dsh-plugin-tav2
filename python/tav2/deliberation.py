"""译前推敲：多方位评估候选术语，联网查证为证据，高置信自动采纳。"""

from __future__ import annotations

from typing import Any

from tav2.llm import BaseLLM, LLMError
from tav2.prompts import DELIBERATION_BATCH_PROMPT, DELIBERATION_EVAL_PROMPT, render
from tav2.websearch import search


def _evidence_text(results: list[dict[str, str]]) -> str:
    if not results:
        return "（无查证结果）"
    lines = []
    for r in results[:3]:
        lines.append(f"- {r.get('title') or ''}（{r.get('url') or ''}）：{r.get('snippet') or ''}")
    return "\n".join(lines)


def evaluate_candidates(
    llm: BaseLLM,
    db: Any,
    cfg: dict[str, Any],
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, int]:
    """评估候选：联网查证 + LLM 多方位决策；结果写回 DB。

    返回统计 {evaluated, auto_locked, pending_approval, failed}。
    """

    if candidates is None:
        rows = db.conn.execute(
            "SELECT * FROM terms WHERE status='candidate' ORDER BY id"
        ).fetchall()
        candidates = [dict(r) for r in rows]
    stats = {"evaluated": 0, "auto_locked": 0, "pending_approval": 0, "failed": 0}

    items = [dict(c) for c in candidates if str(c.get("source") or "").strip()]
    batch_size = max(1, int(cfg.get("deliberation", {}).get("batch_size", 10)))
    # 推敲背景：确认过的世界书条目（常驻 + 按候选语境命中）。
    worldbook = db.load_worldbook()
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        if len(batch) <= 1:
            for cand in batch:
                _evaluate_one(llm, db, cfg, cand, stats, worldbook)
        else:
            _evaluate_batch(llm, db, cfg, batch, stats, worldbook)
    return stats


def _evaluate_one(
    llm: BaseLLM,
    db: Any,
    cfg: dict[str, Any],
    cand: dict[str, Any],
    stats: dict[str, int],
    worldbook: list[dict[str, Any]],
) -> None:
    """逐条评估：联网查证 + 单条决策。"""

    source = str(cand.get("source") or "").strip()
    context = _context_text(cand)
    query = f'"{source}" 翻译 中文 译名' if re_search_latin(source) else f"{source} 译名"
    results = search(cfg, db, query)
    prompt = render(DELIBERATION_EVAL_PROMPT.template)
    wb = _worldbook_context(worldbook, f"{source}\n{context}")
    user = (
        f"候选：{source}\n"
        f"类别：{cand.get('category') or ''}\n"
        f"出现次数：{cand.get('frequency') or '?'}\n"
        f"出现语境：\n{context}\n"
        f"世界书背景：{wb if wb else '（无）'}\n"
        f"考量维度：用典、玩梗、文化、韵律、双关、短习俚等，综合判定译名。\n"
        f"查证证据：\n{_evidence_text(results)}"
    )
    try:
        data = llm.chat_json(prompt, user)
    except (LLMError, ValueError, TypeError):
        stats["failed"] += 1
        return
    _apply_decision(db, cand, data, stats)


def _evaluate_batch(
    llm: BaseLLM,
    db: Any,
    cfg: dict[str, Any],
    batch: list[dict[str, Any]],
    stats: dict[str, int],
    worldbook: list[dict[str, Any]],
) -> None:
    """批量评估：一次请求评估整批候选；失败时逐条兜底，保证不丢候选。"""

    rows: list[str] = []
    for idx, cand in enumerate(batch, start=1):
        source = str(cand.get("source") or "").strip()
        query = f'"{source}" 翻译 中文 译名' if re_search_latin(source) else f"{source} 译名"
        results = search(cfg, db, query)
        wb = _worldbook_context(worldbook, f"{source}\n{_context_text(cand)}")
        rows.append(
            f"{idx}. 候选：{source}\n"
            f"类别：{cand.get('category') or ''}\n"
            f"出现次数：{cand.get('frequency') or '?'}\n"
            f"出现语境：\n{_context_text(cand)}\n"
            f"世界书背景：{wb if wb else '（无）'}\n"
            f"考量维度：用典、玩梗、文化、韵律、双关、短习俚等，综合判定译名。\n"
            f"查证证据：\n{_evidence_text(results)}"
        )
    prompt = render(DELIBERATION_BATCH_PROMPT.template)
    user = "\n\n".join(rows)
    try:
        decisions = llm.chat_json_array(prompt, user)
    except (LLMError, ValueError, TypeError):
        for cand in batch:
            _evaluate_one(llm, db, cfg, cand, stats, worldbook)
        return
    by_source = {
        str(d.get("source") or "").strip(): d
        for d in decisions
        if isinstance(d, dict)
    }
    for cand in batch:
        decision = by_source.get(str(cand.get("source") or "").strip())
        if decision is None:
            stats["failed"] += 1
            continue
        _apply_decision(db, cand, decision, stats)


def _apply_decision(
    db: Any,
    cand: dict[str, Any],
    data: dict[str, Any],
    stats: dict[str, int],
) -> None:
    """把单条决策落库：候选更新 + 高置信自动锁定或进审批队列。"""

    source = str(cand.get("source") or "").strip()
    target = str(data.get("target") or "").strip()
    confidence = str(data.get("confidence") or "low")
    rationale = str(data.get("rationale") or "")
    collision = str(data.get("collision") or "")
    if not target:
        stats["failed"] += 1
        return
    db.upsert_term(
        source,
        target,
        str(cand.get("category") or ""),
        status="candidate",
        confidence=confidence,
        evidence=rationale,
    )
    stats["evaluated"] += 1
    term_id = db.conn.execute(
        "SELECT id FROM terms WHERE source=? AND target=?", (source, target)
    ).fetchone()
    if confidence == "high" and not collision:
        if term_id is not None:
            db.decide_term(int(term_id["id"]), "locked")
        stats["auto_locked"] += 1
    else:
        db.add_approval(
            "term",
            {
                "source": source,
                "target": target,
                "confidence": confidence,
                "rationale": rationale,
            },
        )
        stats["pending_approval"] += 1


def _context_text(cand: dict[str, Any]) -> str:
    samples = cand.get("samples") or []
    if samples:
        return "\n".join(str(s) for s in samples[:3])
    return "（无语境样本）"


def _worldbook_context(worldbook: list[dict[str, Any]], text: str) -> str:
    """用确认过的世界书条目按文本激活，拼成推敲背景（常驻 + 命中）。"""

    import re

    constants: list[dict[str, Any]] = []
    hits: list[dict[str, Any]] = []
    for e in worldbook:
        if e.get("kind") == "constant":
            constants.append(e)
            continue
        for kw in e.get("keywords") or []:
            kw = str(kw).strip()
            if not kw:
                continue
            if re.search(r"[A-Za-z]", kw):
                pattern = r"(?<![A-Za-z0-9_])" + re.escape(kw) + r"(?![A-Za-z0-9_])"
                if re.search(pattern, text, re.IGNORECASE):
                    hits.append(e)
                    break
            elif kw in text:
                hits.append(e)
                break
    items = constants + hits
    if not items:
        return ""
    return "\n".join(f"【{e.get('title') or ''}】{e.get('content') or ''}" for e in items)


def re_search_latin(text: str) -> bool:
    import re

    return bool(re.search(r"[A-Za-z]", text))
