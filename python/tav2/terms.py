"""术语链路：候选入库、锁定、滚动新词队列。"""

from __future__ import annotations

from typing import Any


def seed_terms(db: Any, candidates: list[dict[str, Any]]) -> int:
    """把快筛候选写入 DB（status=candidate，不去重已存在项）。返回新增数。"""

    count = 0
    for cand in candidates:
        source = str(cand.get("source") or "").strip()
        if not source:
            continue
        category = "name" if cand.get("kind") in ("name", "allcaps") else "term"
        existing = db.conn.execute(
            "SELECT id FROM terms WHERE source=? AND status='candidate'", (source,)
        ).fetchone()
        if existing:
            continue
        db.upsert_term(source, "", category, status="candidate", confidence="medium")
        count += 1
    return count


def lock_terms(db: Any, items: list[tuple[str, str, str]]) -> int:
    """批量锁定译名（源词, 译词, 类别）。返回锁定数。"""

    count = 0
    for source, target, category in items:
        if not source.strip() or not target.strip():
            continue
        db.upsert_term(source, target, category, status="locked", confidence="human")
        count += 1
    return count


def queue_rolling_flags(db: Any, flags: list[dict[str, str]]) -> int:
    """把理解记录中的新词/新角色标记送入审批队列。返回入队数。"""

    count = 0
    for flag in flags:
        kind = str(flag.get("kind") or "")
        source = str(flag.get("source") or "").strip()
        if kind not in ("name", "term", "style") or not source:
            continue
        existing = db.conn.execute(
            "SELECT id FROM approval_queue WHERE kind=? AND payload LIKE ? AND status='pending'",
            (kind, f'%"source": "{source}"%'),
        ).fetchone()
        if existing:
            continue
        db.add_approval(kind, {"source": source, "hint": str(flag.get("hint") or "")})
        count += 1
    return count


def auto_lock_high_confidence(db: Any) -> int:
    """把高置信且无撞车的待决候选自动锁定（由 deliberation 写入后调用）。返回锁定数。"""

    rows = db.conn.execute(
        "SELECT id, source, target, category FROM terms "
        "WHERE status='candidate' AND confidence='high' AND target != ''"
    ).fetchall()
    locked = 0
    for row in rows:
        db.decide_term(int(row["id"]), "locked")
        locked += 1
    return locked
