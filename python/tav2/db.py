"""项目级 SQLite 知识库：单元/术语/世界书/角色/理解记录/分支摘要/TM/提案/审批/用量。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from tav2.models import Document, UnderstandingRecord


_DDL = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS units (
    unit_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    file TEXT NOT NULL DEFAULT '',
    scene_id TEXT NOT NULL DEFAULT '',
    source_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    markup TEXT NOT NULL DEFAULT '',
    speaker TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence TEXT NOT NULL DEFAULT 'medium',
    evidence TEXT NOT NULL DEFAULT '',
    decided_at TEXT,
    created_at TEXT,
    UNIQUE (source, target)
);

CREATE TABLE IF NOT EXISTS worldbook_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'keyword',
    title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL DEFAULT '',
    source_refs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'confirmed',
    linked_term TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS characters (
    speaker TEXT PRIMARY KEY,
    name_zh TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    style_notes TEXT NOT NULL DEFAULT '',
    reviewed INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT
);

CREATE TABLE IF NOT EXISTS scene_understandings (
    scene_id TEXT PRIMARY KEY,
    branch TEXT NOT NULL DEFAULT 'main',
    record TEXT NOT NULL,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS branch_summaries (
    branch TEXT PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tm (
    source_hash TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    translation TEXT NOT NULL,
    context_fp TEXT NOT NULL DEFAULT '',
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_hash, unit_id)
);

CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
    run_id TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    elapsed_seconds REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id)
);

CREATE TABLE IF NOT EXISTS search_cache (
    query_hash TEXT PRIMARY KEY,
    engine TEXT NOT NULL DEFAULT '',
    query TEXT NOT NULL DEFAULT '',
    results TEXT NOT NULL DEFAULT '[]',
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    active_goal TEXT NOT NULL DEFAULT '',
    goals TEXT NOT NULL DEFAULT '[]',
    plan TEXT NOT NULL DEFAULT '[]',
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    autonomy TEXT NOT NULL DEFAULT 'auto_low',
    protocol TEXT NOT NULL DEFAULT 'react',
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT NOT NULL DEFAULT '',
    turns INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    tool TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    tool_call_id TEXT NOT NULL DEFAULT '',
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_units_scene ON units(scene_id);
CREATE INDEX IF NOT EXISTS idx_terms_status ON terms(status);
CREATE INDEX IF NOT EXISTS idx_understandings_branch ON scene_understandings(branch);
CREATE INDEX IF NOT EXISTS idx_agent_actions_run ON agent_actions(run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, id);
"""


def source_hash(text: str) -> str:
    return hashlib.md5((text or "").encode("utf-8")).hexdigest()


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# 会话目标队列的原子抢占/释放在本进程内串行（web 轮询线程与 API 请求并发）
_AGENT_CLAIM_LOCK = threading.Lock()


class ProjectDB:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 分支并行轨道会跨线程使用同一连接；写操作由 TranslateRunner 的共享写锁串行化
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_DDL)
        self._migrate_tm_context_fp()
        self._migrate_worldbook_columns()
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def _migrate_tm_context_fp(self) -> None:
        """老库 tm 表无 context_fp 列时补列（向后兼容，不丢数据）。"""

        cols = {row["name"] for row in self.conn.execute("PRAGMA table_info(tm)")}
        if "context_fp" not in cols:
            self.conn.execute(
                "ALTER TABLE tm ADD COLUMN context_fp TEXT NOT NULL DEFAULT ''"
            )

    def _migrate_worldbook_columns(self) -> None:
        """老库 worldbook_entries 无 status/linked_term 列时补列（存量默认 confirmed，不丢数据）。"""

        cols = {row["name"] for row in self.conn.execute("PRAGMA table_info(worldbook_entries)")}
        if "status" not in cols:
            self.conn.execute(
                "ALTER TABLE worldbook_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'"
            )
        if "linked_term" not in cols:
            self.conn.execute(
                "ALTER TABLE worldbook_entries ADD COLUMN linked_term TEXT NOT NULL DEFAULT ''"
            )

    # ------------------------------------------------------------------ meta

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.conn.commit()

    def get_meta(self, key: str) -> str:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else ""

    # ------------------------------------------------------------------ units

    def sync_units(self, document: Document) -> int:
        """同步文档单元（按 unit_id 幂等 upsert，不覆盖已译状态）。"""

        count = 0
        for scene in document.scenes:
            for unit in scene.units:
                self.conn.execute(
                    "INSERT OR IGNORE INTO units"
                    "(unit_id, kind, file, scene_id, source_hash, source, markup, speaker, status)"
                    "VALUES(?,?,?,?,?,?,?,?, 'pending')",
                    (
                        unit.unit_id,
                        unit.kind,
                        unit.extra.get("file", ""),
                        scene.scene_id,
                        source_hash(unit.source),
                        unit.source,
                        unit.markup,
                        unit.speaker,
                    ),
                )
                count += 1
        self.conn.commit()
        return count

    def unit_status(self, unit_id: str) -> str:
        row = self.conn.execute(
            "SELECT status FROM units WHERE unit_id=?", (unit_id,)
        ).fetchone()
        return str(row["status"]) if row else "pending"

    def set_unit_status(self, unit_id: str, status: str) -> None:
        self.conn.execute(
            "UPDATE units SET status=? WHERE unit_id=?", (status, unit_id)
        )
        self.conn.commit()

    def unit_stats(self) -> dict[str, int]:
        """单元总数与按状态计数。"""

        rows = self.conn.execute(
            "SELECT status, COUNT(*) AS n FROM units GROUP BY status"
        ).fetchall()
        stats: dict[str, int] = {"total": 0, "pending": 0, "translated": 0}
        for r in rows:
            stats["total"] += int(r["n"])
            status = str(r["status"])
            if status in stats:
                stats[status] = int(r["n"])
        return stats

    def pending_unit_ids(self) -> list[str]:
        rows = self.conn.execute(
            "SELECT unit_id FROM units WHERE status='pending' ORDER BY rowid"
        ).fetchall()
        return [str(r["unit_id"]) for r in rows]

    # ------------------------------------------------------------------ terms

    def upsert_term(
        self,
        source: str,
        target: str,
        category: str = "",
        status: str = "candidate",
        confidence: str = "medium",
        evidence: str = "",
    ) -> None:
        self.conn.execute(
            "INSERT INTO terms(source, target, category, status, confidence, evidence, created_at)"
            "VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(source, target) DO UPDATE SET "
            "status=excluded.status, confidence=excluded.confidence, evidence=excluded.evidence",
            (source, target, category, status, confidence, evidence, _now()),
        )
        self.conn.commit()

    def locked_terms(self) -> list[dict[str, str]]:
        rows = self.conn.execute(
            "SELECT source, target, category FROM terms WHERE status='locked' ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]

    def pending_terms(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM terms WHERE status='candidate' ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]

    def decide_term(self, term_id: int, status: str) -> bool:
        if status not in ("locked", "rejected"):
            return False
        cur = self.conn.execute(
            "UPDATE terms SET status=?, decided_at=? WHERE id=?", (status, _now(), term_id)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def update_term(
        self,
        term_id: int,
        target: str | None = None,
        category: str | None = None,
    ) -> bool:
        """更新术语译文/类别（状态变更请用 decide_term）。"""

        sets: list[str] = []
        values: list[Any] = []
        if target is not None:
            sets.append("target=?")
            values.append(str(target))
        if category is not None:
            sets.append("category=?")
            values.append(str(category))
        if not sets:
            return False
        values.append(term_id)
        cur = self.conn.execute(
            f"UPDATE terms SET {', '.join(sets)} WHERE id=?", (*values,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def all_terms(self, status: str | None = None) -> list[dict[str, Any]]:
        """全量术语（含 id），可按 status 过滤。"""

        sql = "SELECT * FROM terms"
        if status:
            sql += " WHERE status=?"
        sql += " ORDER BY id"
        rows = self.conn.execute(sql, (status,) if status else ()).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ worldbook

    def save_worldbook(self, entries: list[dict[str, Any]]) -> int:
        """全量落库（先清空再写入，供生成流程使用）。"""

        self.conn.execute("DELETE FROM worldbook_entries")
        now = _now()
        for e in entries:
            self.conn.execute(
                "INSERT INTO worldbook_entries"
                "(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)"
                "VALUES(?,?,?,?,?, 'confirmed', ?, 1, ?, ?)",
                (
                    str(e.get("kind") or "keyword"),
                    str(e.get("title") or ""),
                    json.dumps(e.get("keywords") or [], ensure_ascii=False),
                    str(e.get("content") or ""),
                    json.dumps(e.get("source_refs") or [], ensure_ascii=False),
                    str(e.get("linked_term") or ""),
                    now,
                    now,
                ),
            )
        self.conn.commit()
        return len(entries)

    def load_worldbook(self, active_only: bool = True) -> list[dict[str, Any]]:
        sql = "SELECT * FROM worldbook_entries"
        if active_only:
            sql += " WHERE active=1 AND status='confirmed'"
        sql += " ORDER BY id"
        rows = self.conn.execute(sql).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["keywords"] = json.loads(item.get("keywords") or "[]")
            item["source_refs"] = json.loads(item.get("source_refs") or "[]")
            out.append(item)
        return out

    def update_worldbook_entry(self, entry_id: int, **fields: Any) -> bool:
        allowed = {"kind", "title", "content", "active", "keywords", "source_refs"}
        allowed.update({"status", "linked_term"})
        sets: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key in ("keywords", "source_refs") and isinstance(value, list):
                value = json.dumps(value, ensure_ascii=False)
            sets.append(f"{key}=?")
            values.append(value)
        if not sets:
            return False
        cur = self.conn.execute(
            f"UPDATE worldbook_entries SET {', '.join(sets)}, updated_at=? WHERE id=?",
            (*values, _now(), entry_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def list_worldbook(self, status: str | None = None) -> list[dict[str, Any]]:
        """世界书条目全量（含 proposed，供编辑/列表用）；软删（active=0）不返回。"""

        sql = "SELECT * FROM worldbook_entries WHERE active=1"
        params: list[Any] = []
        if status:
            sql += " AND status=?"
            params.append(status)
        sql += " ORDER BY id"
        rows = self.conn.execute(sql, params).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["keywords"] = json.loads(item.get("keywords") or "[]")
            item["source_refs"] = json.loads(item.get("source_refs") or "[]")
            out.append(item)
        return out

    def propose_worldbook(self, entries: list[dict[str, Any]]) -> int:
        """幂等提案：同 (kind,title) 已有 active 条目则跳过；新条目以 proposed 入库。"""

        now = _now()
        count = 0
        for e in entries:
            kind = str(e.get("kind") or "keyword")
            title = str(e.get("title") or "").strip()
            if not title:
                continue
            exists = self.conn.execute(
                "SELECT 1 FROM worldbook_entries WHERE kind=? AND title=? AND active=1 LIMIT 1",
                (kind, title),
            ).fetchone()
            if exists:
                continue
            self.conn.execute(
                "INSERT INTO worldbook_entries"
                "(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)"
                "VALUES(?,?,?,?,?, 'proposed', ?, 1, ?, ?)",
                (
                    kind,
                    title,
                    json.dumps(e.get("keywords") or [], ensure_ascii=False),
                    str(e.get("content") or ""),
                    json.dumps(e.get("source_refs") or [], ensure_ascii=False),
                    str(e.get("linked_term") or ""),
                    now,
                    now,
                ),
            )
            count += 1
        self.conn.commit()
        return count

    def confirm_worldbook(self, ids: list[int]) -> int:
        """确认条目（proposed → confirmed）。"""

        if not ids:
            return 0
        ph = ",".join(["?"] * len(ids))
        cur = self.conn.execute(
            f"UPDATE worldbook_entries SET status='confirmed', active=1, updated_at=? WHERE id IN ({ph})",
            (_now(), *ids),
        )
        self.conn.commit()
        return cur.rowcount

    def reject_worldbook(self, ids: list[int]) -> int:
        """拒绝/删除条目（软删：active=0 + status='rejected'）。"""

        if not ids:
            return 0
        ph = ",".join(["?"] * len(ids))
        cur = self.conn.execute(
            f"UPDATE worldbook_entries SET status='rejected', active=0, updated_at=? WHERE id IN ({ph})",
            (_now(), *ids),
        )
        self.conn.commit()
        return cur.rowcount

    def add_worldbook_entry(self, entry: dict[str, Any]) -> int:
        """手工新增一条世界书条目（默认 confirmed）。"""

        cur = self.conn.execute(
            "INSERT INTO worldbook_entries"
            "(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)"
            "VALUES(?,?,?,?,?, 'confirmed', ?, 1, ?, ?)",
            (
                str(entry.get("kind") or "lore"),
                str(entry.get("title") or "").strip(),
                json.dumps(entry.get("keywords") or [], ensure_ascii=False),
                str(entry.get("content") or ""),
                json.dumps(entry.get("source_refs") or [], ensure_ascii=False),
                str(entry.get("linked_term") or ""),
                _now(),
                _now(),
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def worldbook_term_conflicts(self) -> list[dict[str, Any]]:
        """术语↔世界书译名一致性：linked_term 指向的锁定术语译名与世界书条目标题冲突时列出。"""

        locked = self.locked_terms()
        entries = self.list_worldbook("confirmed")
        out: list[dict[str, Any]] = []
        for e in entries:
            linked = str(e.get("linked_term") or "").strip()
            if not linked:
                continue
            term = next((t for t in locked if t.get("source") == linked), None)
            if term and str(e.get("title") or "").strip() != str(term.get("target") or ""):
                out.append({
                    "term": linked,
                    "termTarget": str(term.get("target") or ""),
                    "entryId": int(e.get("id") or 0),
                    "entryTitle": str(e.get("title") or ""),
                })
        return out

    # ------------------------------------------------------------------ characters

    def upsert_character(self, speaker: str, name_zh: str = "", aliases: str = "") -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO characters(speaker, name_zh, aliases, first_seen)"
            "VALUES(?,?,?,?)",
            (speaker, name_zh, aliases, _now()),
        )
        if name_zh:
            self.conn.execute(
                "UPDATE characters SET name_zh=? WHERE speaker=? AND name_zh=''",
                (name_zh, speaker),
            )
        self.conn.commit()

    def get_characters(self) -> dict[str, dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM characters ORDER BY speaker").fetchall()
        return {str(r["speaker"]): dict(r) for r in rows}

    def set_character_style(self, speaker: str, note: str) -> None:
        self.conn.execute(
            "UPDATE characters SET style_notes=? WHERE speaker=?", (note, speaker)
        )
        self.conn.commit()

    # ------------------------------------------------------------------ understanding / summaries

    def save_understanding(self, record: UnderstandingRecord, branch: str = "main") -> None:
        self.conn.execute(
            "INSERT INTO scene_understandings(scene_id, branch, record, created_at) "
            "VALUES(?,?,?,?) "
            "ON CONFLICT(scene_id) DO UPDATE SET branch=excluded.branch, "
            "record=excluded.record, created_at=excluded.created_at",
            (record.scene_id, branch, json.dumps(record.to_dict(), ensure_ascii=False), _now()),
        )
        self.conn.commit()

    def all_understandings(self) -> list[dict[str, Any]]:
        """全部场景理解记录（record 已解析为 dict）。"""

        rows = self.conn.execute(
            "SELECT scene_id, branch, record, created_at "
            "FROM scene_understandings ORDER BY rowid"
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["record"] = json.loads(item["record"])
            out.append(item)
        return out

    def units_with_translations(self, scene_id: str) -> list[dict[str, Any]]:
        """场景内单元及其译文（TM 按 source_hash+unit_id 唯一关联）。"""

        rows = self.conn.execute(
            "SELECT u.unit_id, u.kind, u.source, u.markup, u.speaker, u.status, "
            "COALESCE(t.translation, '') AS translation "
            "FROM units u LEFT JOIN tm t "
            "ON t.source_hash = u.source_hash AND t.unit_id = u.unit_id "
            "WHERE u.scene_id=? ORDER BY u.rowid",
            (scene_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_understanding(self, scene_id: str) -> UnderstandingRecord | None:
        row = self.conn.execute(
            "SELECT record FROM scene_understandings WHERE scene_id=?", (scene_id,)
        ).fetchone()
        if not row:
            return None
        return UnderstandingRecord.from_dict(json.loads(row["record"]))

    def recent_understandings(self, branch: str, limit: int = 5) -> list[UnderstandingRecord]:
        rows = self.conn.execute(
            "SELECT record FROM scene_understandings WHERE branch=? "
            "ORDER BY rowid DESC LIMIT ?",
            (branch, limit),
        ).fetchall()
        return [UnderstandingRecord.from_dict(json.loads(r["record"])) for r in reversed(rows)]

    def get_summary(self, branch: str = "main") -> str:
        row = self.conn.execute(
            "SELECT summary FROM branch_summaries WHERE branch=?", (branch,)
        ).fetchone()
        return str(row["summary"]) if row else ""

    def save_summary(self, branch: str, summary: str, position: int) -> None:
        self.conn.execute(
            "INSERT INTO branch_summaries(branch, summary, position, updated_at) "
            "VALUES(?,?,?,?) "
            "ON CONFLICT(branch) DO UPDATE SET summary=excluded.summary, "
            "position=excluded.position, updated_at=excluded.updated_at",
            (branch, summary, position, _now()),
        )
        self.conn.commit()

    # ------------------------------------------------------------------ tm

    def tm_get(self, source: str, context_fp: str | None = None) -> str:
        """取同源译文：context_fp 为空取最高命中（few-shot 用）；给定则精确匹配上下文指纹。"""

        if context_fp is None:
            row = self.conn.execute(
                "SELECT translation FROM tm WHERE source_hash=? ORDER BY hits DESC LIMIT 1",
                (source_hash(source),),
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT translation FROM tm WHERE source_hash=? AND context_fp=? "
                "ORDER BY hits DESC LIMIT 1",
                (source_hash(source), context_fp),
            ).fetchone()
        return str(row["translation"]) if row else ""

    def tm_put(
        self, source: str, unit_id: str, translation: str, context_fp: str = ""
    ) -> None:
        self.conn.execute(
            "INSERT INTO tm(source_hash, unit_id, translation, context_fp, hits) "
            "VALUES(?,?,?,?,1) "
            "ON CONFLICT(source_hash, unit_id) DO UPDATE SET "
            "translation=excluded.translation, context_fp=excluded.context_fp, hits=hits+1",
            (source_hash(source), unit_id, translation, context_fp),
        )
        self.conn.commit()

    def tm_recent(self, limit: int = 50) -> list[tuple[str, str]]:
        rows = self.conn.execute(
            "SELECT translation FROM tm ORDER BY hits DESC, rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out: list[tuple[str, str]] = []
        for r in rows:
            out.append(("", str(r["translation"])))
        return out

    # ------------------------------------------------------------------ proposals / approval queue

    def add_proposal(self, kind: str, payload: dict[str, Any]) -> int:
        cur = self.conn.execute(
            "INSERT INTO proposals(kind, payload, status, created_at) VALUES(?,?, 'pending', ?)",
            (kind, json.dumps(payload, ensure_ascii=False), _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def pending_proposals(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM proposals WHERE status='pending' ORDER BY id"
        ).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["payload"] = json.loads(item["payload"])
            out.append(item)
        return out

    def decide_proposal(self, proposal_id: int, status: str) -> bool:
        if status not in ("approved", "rejected"):
            return False
        cur = self.conn.execute(
            "UPDATE proposals SET status=?, decided_at=? WHERE id=?",
            (status, _now(), proposal_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def add_approval(self, kind: str, payload: dict[str, Any]) -> int:
        cur = self.conn.execute(
            "INSERT INTO approval_queue(kind, payload, status, created_at) "
            "VALUES(?,?, 'pending', ?)",
            (kind, json.dumps(payload, ensure_ascii=False), _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def pending_approvals(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM approval_queue WHERE status='pending' ORDER BY id"
        ).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["payload"] = json.loads(item["payload"])
            out.append(item)
        return out

    def approval_by_id(self, approval_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM approval_queue WHERE id=?", (approval_id,)
        ).fetchone()
        if not row:
            return None
        item = dict(row)
        item["payload"] = json.loads(item["payload"])
        return item

    def decide_approval(self, approval_id: int, status: str) -> bool:
        if status not in ("approved", "rejected"):
            return False
        cur = self.conn.execute(
            "UPDATE approval_queue SET status=?, decided_at=? WHERE id=?",
            (status, _now(), approval_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------ runs / usage

    def begin_run(self, run_id: str, kind: str) -> None:
        self.conn.execute(
            "INSERT INTO runs(run_id, kind, status, started_at) VALUES(?,?, 'running', ?)",
            (run_id, kind, _now()),
        )
        self.conn.execute(
            "INSERT OR IGNORE INTO usage(run_id) VALUES(?)", (run_id,)
        )
        self.conn.commit()

    def finish_run(self, run_id: str, summary: str = "") -> None:
        self.conn.execute(
            "UPDATE runs SET status='done', summary=?, finished_at=? WHERE run_id=?",
            (summary, _now(), run_id),
        )
        self.conn.commit()

    def fail_run(self, run_id: str, summary: str = "") -> None:
        self.conn.execute(
            "UPDATE runs SET status='error', summary=?, finished_at=? WHERE run_id=?",
            (summary, _now(), run_id),
        )
        self.conn.commit()

    def add_usage(
        self,
        run_id: str,
        calls: int = 0,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        elapsed_seconds: float = 0.0,
    ) -> None:
        self.conn.execute(
            "INSERT INTO usage(run_id, calls, prompt_tokens, completion_tokens, "
            "total_tokens, elapsed_seconds) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(run_id) DO UPDATE SET "
            "calls=calls+excluded.calls, prompt_tokens=prompt_tokens+excluded.prompt_tokens, "
            "completion_tokens=completion_tokens+excluded.completion_tokens, "
            "total_tokens=total_tokens+excluded.total_tokens, "
            "elapsed_seconds=elapsed_seconds+excluded.elapsed_seconds",
            (
                run_id,
                calls,
                prompt_tokens,
                completion_tokens,
                prompt_tokens + completion_tokens,
                elapsed_seconds,
            ),
        )
        self.conn.commit()

    def usage_for(self, run_id: str) -> dict[str, Any]:
        row = self.conn.execute("SELECT * FROM usage WHERE run_id=?", (run_id,)).fetchone()
        return dict(row) if row else {}

    def recent_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM runs ORDER BY rowid DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def run_by_id(self, run_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------ search cache

    def search_cache_get(self, query_hash: str) -> list[dict[str, Any]] | None:
        row = self.conn.execute(
            "SELECT results FROM search_cache WHERE query_hash=?", (query_hash,)
        ).fetchone()
        if not row:
            return None
        return json.loads(row["results"])

    def search_cache_put(
        self, query_hash: str, engine: str, query: str, results: list[dict[str, Any]]
    ) -> None:
        self.conn.execute(
            "INSERT INTO search_cache(query_hash, engine, query, results, created_at) "
            "VALUES(?,?,?,?,?) "
            "ON CONFLICT(query_hash) DO UPDATE SET results=excluded.results",
            (query_hash, engine, query, json.dumps(results, ensure_ascii=False), _now()),
        )
        self.conn.commit()

    # ------------------------------------------------------------------ agent 会话

    def create_agent_session(self, session_id: str) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO agent_sessions(session_id, status, created_at, updated_at) "
            "VALUES(?, 'idle', ?, ?)",
            (session_id, _now(), _now()),
        )
        self.conn.commit()

    def get_agent_session(self, session_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM agent_sessions WHERE session_id=?", (session_id,)
        ).fetchone()
        if not row:
            return None
        item = dict(row)
        item["goals"] = json.loads(item.get("goals") or "[]")
        item["plan"] = json.loads(item.get("plan") or "[]")
        return item

    def set_agent_session_status(
        self, session_id: str, status: str, active_goal: str = ""
    ) -> None:
        self.conn.execute(
            "UPDATE agent_sessions SET status=?, active_goal=?, updated_at=? WHERE session_id=?",
            (status, active_goal, _now(), session_id),
        )
        self.conn.commit()

    def session_add_goal(
        self,
        session_id: str,
        goal: str,
        autonomy: str = "",
        max_turns: int = 0,
    ) -> int:
        """追加目标到会话队列；返回队列长度。"""

        self.create_agent_session(session_id)
        with _AGENT_CLAIM_LOCK:
            session = self.get_agent_session(session_id)
            goals = list(session["goals"]) if session else []
            goals.append(
                {
                    "goal": goal,
                    "autonomy": autonomy,
                    "max_turns": max_turns,
                    "queued_at": _now(),
                }
            )
            self.conn.execute(
                "UPDATE agent_sessions SET goals=?, updated_at=? WHERE session_id=?",
                (json.dumps(goals, ensure_ascii=False), _now(), session_id),
            )
            self.conn.commit()
            return len(goals)

    def session_claim_goal(self, session_id: str) -> dict[str, Any] | None:
        """原子抢占队首目标（仅 idle 可抢占）；抢占后会话置 running。"""

        with _AGENT_CLAIM_LOCK:
            session = self.get_agent_session(session_id)
            if not session or session["status"] != "idle":
                return None
            goals = list(session["goals"])
            if not goals:
                return None
            claimed = goals.pop(0)
            self.conn.execute(
                "UPDATE agent_sessions SET status='running', active_goal=?, goals=?, updated_at=? "
                "WHERE session_id=?",
                (str(claimed.get("goal") or ""), json.dumps(goals, ensure_ascii=False), _now(), session_id),
            )
            self.conn.commit()
            return claimed

    def session_release_claim(self, session_id: str, claimed: dict[str, Any]) -> None:
        """抢占后未能启动：目标放回队首，会话回 idle。"""

        with _AGENT_CLAIM_LOCK:
            session = self.get_agent_session(session_id)
            goals = [claimed] + (list(session["goals"]) if session else [])
            self.conn.execute(
                "UPDATE agent_sessions SET status='idle', active_goal='', goals=?, updated_at=? "
                "WHERE session_id=?",
                (json.dumps(goals, ensure_ascii=False), _now(), session_id),
            )
            self.conn.commit()

    def session_finish_episode(self, session_id: str) -> None:
        """episode 结束：stopping 保持暂停，否则回 idle。"""

        with _AGENT_CLAIM_LOCK:
            session = self.get_agent_session(session_id)
            if not session:
                return
            status = "stopping" if session["status"] == "stopping" else "idle"
            self.conn.execute(
                "UPDATE agent_sessions SET status=?, active_goal='', updated_at=? WHERE session_id=?",
                (status, _now(), session_id),
            )
            self.conn.commit()

    def session_set_plan(self, session_id: str, steps: list[dict[str, Any]]) -> None:
        self.create_agent_session(session_id)
        cleaned: list[dict[str, Any]] = []
        for s in steps:
            if not isinstance(s, dict):
                continue
            title = str(s.get("title") or "").strip()
            tool = str(s.get("tool") or "").strip()
            if not title or not tool:
                continue
            cleaned.append(
                {
                    "title": title,
                    "tool": tool,
                    "note": str(s.get("note") or ""),
                    "status": "pending",
                }
            )
        self.conn.execute(
            "UPDATE agent_sessions SET plan=?, updated_at=? WHERE session_id=?",
            (json.dumps(cleaned, ensure_ascii=False), _now(), session_id),
        )
        self.conn.commit()

    def session_plan(self, session_id: str) -> list[dict[str, Any]]:
        session = self.get_agent_session(session_id)
        return list(session["plan"]) if session else []

    def session_mark_plan_step(self, session_id: str, tool: str) -> bool:
        """把第一个 pending 且 tool 匹配的步骤标记为 done。"""

        with _AGENT_CLAIM_LOCK:
            plan = self.session_plan(session_id)
            for step in plan:
                if step.get("status") == "pending" and step.get("tool") == tool:
                    step["status"] = "done"
                    self.conn.execute(
                        "UPDATE agent_sessions SET plan=?, updated_at=? WHERE session_id=?",
                        (json.dumps(plan, ensure_ascii=False), _now(), session_id),
                    )
                    self.conn.commit()
                    return True
            return False

    # ------------------------------------------------------------------ agent 运行

    def upsert_agent_run(
        self,
        run_id: str,
        session_id: str,
        goal: str,
        autonomy: str,
        protocol: str,
        status: str,
        turns: int,
    ) -> None:
        self.conn.execute(
            "INSERT INTO agent_runs(run_id, session_id, goal, autonomy, protocol, status, turns, started_at) "
            "VALUES(?,?,?,?,?,?,?,?) "
            "ON CONFLICT(run_id) DO UPDATE SET "
            "session_id=excluded.session_id, goal=excluded.goal, autonomy=excluded.autonomy, "
            "protocol=excluded.protocol, status=excluded.status, turns=excluded.turns",
            (run_id, session_id, goal, autonomy, protocol, status, turns, _now()),
        )
        self.conn.commit()

    def set_agent_run_status(self, run_id: str, status: str, summary: str = "") -> None:
        self.conn.execute(
            "UPDATE agent_runs SET status=?, summary=?, finished_at=? WHERE run_id=?",
            (status, summary, _now(), run_id),
        )
        self.conn.commit()

    def set_agent_run_turns(self, run_id: str, turns: int) -> None:
        self.conn.execute(
            "UPDATE agent_runs SET turns=? WHERE run_id=?", (int(turns), run_id)
        )
        self.conn.commit()

    def get_agent_run(self, run_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM agent_runs WHERE run_id=?", (run_id,)
        ).fetchone()
        return dict(row) if row else None

    def latest_agent_run(self, session_id: str = "") -> dict[str, Any] | None:
        sql = "SELECT * FROM agent_runs"
        if session_id:
            sql += " WHERE session_id=?"
        sql += " ORDER BY started_at DESC, rowid DESC LIMIT 1"
        row = self.conn.execute(sql, (session_id,) if session_id else ()).fetchone()
        return dict(row) if row else None

    def recent_agent_runs(
        self, limit: int = 10, session_id: str = ""
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM agent_runs"
        if session_id:
            sql += " WHERE session_id=?"
        sql += " ORDER BY started_at DESC, rowid DESC LIMIT ?"
        rows = self.conn.execute(
            sql, (session_id, limit) if session_id else (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ agent 动作

    def insert_agent_action(
        self,
        run_id: str,
        turn: int,
        tool: str,
        args: dict[str, Any],
        category: str,
        status: str,
        result: str = "",
        error: str = "",
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO agent_actions(run_id, turn, tool, args, category, status, result, error, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                int(turn),
                tool,
                json.dumps(args or {}, ensure_ascii=False),
                category,
                status,
                result,
                error,
                _now(),
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def get_agent_action(self, action_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM agent_actions WHERE id=?", (int(action_id),)
        ).fetchone()
        if not row:
            return None
        item = dict(row)
        item["args"] = json.loads(item.get("args") or "{}")
        return item

    def set_agent_action_status(
        self, action_id: int, status: str, result: str = "", error: str = ""
    ) -> None:
        self.conn.execute(
            "UPDATE agent_actions SET status=?, result=?, error=?, decided_at=? WHERE id=?",
            (status, result, error, _now(), int(action_id)),
        )
        self.conn.commit()

    def pending_agent_actions(self, session_id: str = "") -> list[dict[str, Any]]:
        sql = (
            "SELECT a.* FROM agent_actions a JOIN agent_runs r ON r.run_id = a.run_id "
            "WHERE a.status='pending'"
        )
        if session_id:
            sql += " AND r.session_id=?"
        sql += " ORDER BY a.id"
        rows = self.conn.execute(sql, (session_id,) if session_id else ()).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["args"] = json.loads(item.get("args") or "{}")
            out.append(item)
        return out

    def agent_actions_for_run(
        self, run_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM agent_actions WHERE run_id=? ORDER BY id LIMIT ?",
            (run_id, int(limit)),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["args"] = json.loads(item.get("args") or "{}")
            out.append(item)
        return out

    def agent_actions_for_session(
        self, session_id: str, status: str = "", limit: int = 200
    ) -> list[dict[str, Any]]:
        sql = (
            "SELECT a.* FROM agent_actions a JOIN agent_runs r ON r.run_id = a.run_id "
            "WHERE r.session_id=?"
        )
        if status:
            sql += " AND a.status=?"
        sql += " ORDER BY a.id DESC LIMIT ?"
        rows = self.conn.execute(
            sql, (session_id, status, int(limit)) if status else (session_id, int(limit))
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["args"] = json.loads(item.get("args") or "{}")
            out.append(item)
        return out

    # ------------------------------------------------------------------ agent 消息

    def add_agent_message(
        self,
        session_id: str,
        run_id: str,
        role: str,
        content: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        tool_call_id: str = "",
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO agent_messages(session_id, run_id, role, content, tool_calls, tool_call_id, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                session_id,
                run_id,
                role,
                content or "",
                json.dumps(tool_calls or [], ensure_ascii=False),
                tool_call_id or "",
                _now(),
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def agent_messages(
        self,
        session_id: str = "",
        run_id: str = "",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        if session_id:
            clauses.append("session_id=?")
            values.append(session_id)
        if run_id:
            clauses.append("run_id=?")
            values.append(run_id)
        sql = "SELECT * FROM agent_messages"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC LIMIT ?"
        rows = self.conn.execute(sql, (*values, int(limit))).fetchall()
        out: list[dict[str, Any]] = []
        for r in reversed(rows):
            item = dict(r)
            item["tool_calls"] = json.loads(item.get("tool_calls") or "[]")
            out.append(item)
        return out
