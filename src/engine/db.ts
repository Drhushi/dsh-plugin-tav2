/**
 * ProjectDB 的 TS 等价物：用 better-sqlite3 重写，DDL 与 Python
 * tav2/db.py 的 _DDL 逐字一致（17 张表 + 5 个索引），表结构完全兼容。
 * agent_* 四张表保留 DDL 但引擎不写（tav2 自有 agent 层已冻结）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Document, UnderstandingRecord } from './models'

const DDL = `
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
    worldbook_status TEXT NOT NULL DEFAULT '',
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
`

/** 与 Python hashlib.md5(text.encode('utf-8')).hexdigest() 一致。 */
export function sourceHash(text: string): string {
  return createHash('md5').update((text ?? '').toString(), 'utf8').digest('hex')
}

/**
 * G-1 授权合规记录（存 meta 表，不新增表，保持 17 表 DDL 与 Python 基线兼容）。
 *
 * 公开发布前必须 status='authorized' 且 authorized=true；本地自用/学习开发不受限，
 * 但项目元数据仍记录授权状态。
 */
export interface ComplianceRecord {
  /** unknown | local-only | authorized */
  status: string
  /** 作者/版权方 */
  author?: string
  copyrightOwner?: string
  /** 是否已获得书面授权 */
  authorized?: boolean
  /** 允许的发布渠道/范围 */
  allowedChannels?: string[]
  /** 授权文件相对/绝对路径 */
  licensePath?: string
  notes?: string
  updatedAt?: string
}

/** 与 Python time.strftime('%Y-%m-%d %H:%M:%S') 一致的本地时间。 */
function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 行对象（better-sqlite3 返回普通对象）。 */
type Row = Record<string, unknown>

/** usage 表全量聚合结果。 */
export interface UsageTotals {
  runs: number
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  elapsedSeconds: number
}

/** 解析 JSON 列（Python json.loads 语义）。 */
function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export class ProjectDB {
  readonly path: string
  private db: BetterSqlite3.Database

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new BetterSqlite3(path)
    // 子代理分批并行翻译时多个连接写同一项目库：WAL + busy_timeout 避免
    // SQLITE_BUSY（better-sqlite3 同步语句本就单线程串行，此设置是兜底）。
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(DDL)
    this.migrateTmContextFp()
    this.migrateWorldbookColumns()
    this.migrateTermWorldbookStatus()
  }

  close(): void {
    this.db.close()
  }

  /** 测试/诊断用：全部用户表名（不含 sqlite_* 内部表）。 */
  dumpTables(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Row[]
    return rows.map((r) => String(r.name))
  }

  /** 测试/诊断用：全部用户索引名。 */
  dumpIndexes(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Row[]
    return rows.map((r) => String(r.name))
  }

  /** 测试/诊断用：表的列名。 */
  columnNames(table: string): string[] {
    return (this.db.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .map((c) => c.name)
  }

  /** 老库 tm 表无 context_fp 列时补列（向后兼容，不丢数据）。 */
  private migrateTmContextFp(): void {
    const cols = this.db.pragma('table_info(tm)') as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'context_fp')) {
      this.db.exec("ALTER TABLE tm ADD COLUMN context_fp TEXT NOT NULL DEFAULT ''")
    }
  }

  /** 老库 worldbook_entries 无 status/linked_term 列时补列（存量默认 confirmed，不丢数据）。 */
  private migrateWorldbookColumns(): void {
    const cols = this.db.pragma('table_info(worldbook_entries)') as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'status')) {
      this.db.exec("ALTER TABLE worldbook_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'")
    }
    if (!cols.some((c) => c.name === 'linked_term')) {
      this.db.exec("ALTER TABLE worldbook_entries ADD COLUMN linked_term TEXT NOT NULL DEFAULT ''")
    }
  }

  /** 老库 terms 表无 worldbook_status 列时补列（术语驱动世界书按名字记账，缺列时补空串）。 */
  private migrateTermWorldbookStatus(): void {
    const cols = this.db.pragma('table_info(terms)') as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'worldbook_status')) {
      this.db.exec("ALTER TABLE terms ADD COLUMN worldbook_status TEXT NOT NULL DEFAULT ''")
    }
  }

  // ---------------------------------------------------------------- meta

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value)
  }

  getMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined
    return row ? String(row.value) : ''
  }

  // ---------------------------------------------------------------- G-1 compliance

  /** 写入 G-1 授权合规元数据。 */
  setCompliance(record: ComplianceRecord): void {
    const ts = now()
    const normalized: ComplianceRecord = {
      status: record.status || 'unknown',
      author: record.author ?? '',
      copyrightOwner: record.copyrightOwner ?? '',
      authorized: Boolean(record.authorized),
      allowedChannels: record.allowedChannels ?? [],
      licensePath: record.licensePath ?? '',
      notes: record.notes ?? '',
      updatedAt: ts,
    }
    this.setMeta('compliance.status', normalized.status)
    this.setMeta('compliance.author', normalized.author ?? '')
    this.setMeta('compliance.copyright_owner', normalized.copyrightOwner ?? '')
    this.setMeta('compliance.authorized', String(normalized.authorized ?? false))
    this.setMeta('compliance.allowed_channels', JSON.stringify(normalized.allowedChannels ?? []))
    this.setMeta('compliance.license_path', normalized.licensePath ?? '')
    this.setMeta('compliance.notes', normalized.notes ?? '')
    this.setMeta('compliance.updated_at', ts)
  }

  /** 读取 G-1 授权合规元数据；未设置时返回 unknown/未授权。 */
  getCompliance(): ComplianceRecord {
    const authorized = this.getMeta('compliance.authorized')
    const allowedRaw = this.getMeta('compliance.allowed_channels')
    let allowedChannels: string[] = []
    try {
      const parsed = JSON.parse(allowedRaw || '[]')
      if (Array.isArray(parsed)) allowedChannels = parsed.map(String)
    } catch {
      allowedChannels = allowedRaw ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
    }
    return {
      status: this.getMeta('compliance.status') || 'unknown',
      author: this.getMeta('compliance.author'),
      copyrightOwner: this.getMeta('compliance.copyright_owner'),
      authorized: authorized === 'true',
      allowedChannels,
      licensePath: this.getMeta('compliance.license_path'),
      notes: this.getMeta('compliance.notes'),
      updatedAt: this.getMeta('compliance.updated_at'),
    }
  }

  /** 是否允许公开发布：必须明确 authorized=true 且 status=authorized。 */
  isPublicReleaseAllowed(): boolean {
    const c = this.getCompliance()
    return c.authorized === true && c.status === 'authorized'
  }

  // ---------------------------------------------------------------- units

  /** 同步文档单元（按 unit_id 幂等 upsert，不覆盖已译状态）。 */
  syncUnits(document: Document): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO units'
      + '(unit_id, kind, file, scene_id, source_hash, source, markup, speaker, status)'
      + "VALUES(?,?,?,?,?,?,?,?, 'pending')",
    )
    let count = 0
    for (const scene of document.scenes) {
      for (const unit of scene.units) {
        stmt.run(
          unit.unit_id,
          unit.kind,
          String(unit.extra.file ?? ''),
          scene.scene_id,
          sourceHash(unit.source),
          unit.source,
          unit.markup,
          unit.speaker,
        )
        count += 1
      }
    }
    return count
  }

  unitStatus(unit_id: string): string {
    const row = this.db.prepare('SELECT status FROM units WHERE unit_id=?').get(unit_id) as Row | undefined
    return row ? String(row.status) : 'pending'
  }

  setUnitStatus(unit_id: string, status: string): void {
    this.db.prepare('UPDATE units SET status=? WHERE unit_id=?').run(status, unit_id)
  }

  /** 全部单元（unit_id/source/status，tav2_migrate 迁移对账用）。 */
  allUnits(): Array<{ unit_id: string; source: string; status: string }> {
    const rows = this.db.prepare(
      'SELECT unit_id, source, status FROM units ORDER BY rowid',
    ).all() as Row[]
    return rows.map((r) => ({
      unit_id: String(r.unit_id),
      source: String(r.source),
      status: String(r.status),
    }))
  }

  /** 该单元的 TM 译文（无则空串；tav2_migrate 兜底携译文用）。 */
  unitTranslation(unit_id: string): string {
    const row = this.db.prepare(
      'SELECT t.translation FROM tm t JOIN units u ON u.source_hash = t.source_hash AND u.unit_id = t.unit_id'
      + ' WHERE u.unit_id=? AND t.translation != \'\' LIMIT 1',
    ).get(unit_id) as Row | undefined
    return row ? String(row.translation) : ''
  }

  /** 批量标状态（tav2_migrate 把 changed/added 标 pending、removed 标 removed）。 */
  setUnitStatuses(unitIds: string[], status: string): void {
    if (unitIds.length === 0) return
    const stmt = this.db.prepare('UPDATE units SET status=? WHERE unit_id=?')
    for (const id of unitIds) stmt.run(status, id)
  }

  /** 更新单元原文并同步 source_hash（tav2_migrate 对 changed 单元用）。 */
  updateUnitSource(unit_id: string, source: string): void {
    this.db.prepare('UPDATE units SET source=?, source_hash=? WHERE unit_id=?').run(
      source, sourceHash(source), unit_id,
    )
  }

  /** 单元总数与按状态计数。 */
  unitStats(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) AS n FROM units GROUP BY status',
    ).all() as Row[]
    const stats: Record<string, number> = { total: 0, pending: 0, translated: 0 }
    for (const r of rows) {
      const status = String(r.status)
      stats.total! += Number(r.n)
      if (status in stats) stats[status]! += Number(r.n)
    }
    return stats
  }

  pendingUnitIds(): string[] {
    const rows = this.db.prepare(
      "SELECT unit_id FROM units WHERE status='pending' ORDER BY rowid",
    ).all() as Row[]
    return rows.map((r) => String(r.unit_id))
  }

  /** 按场景聚合单元状态（报表用）：scene_id → { total, translated, pending }。 */
  sceneUnitStats(): Record<string, { total: number; translated: number; pending: number }> {
    const rows = this.db.prepare(
      'SELECT scene_id, status, COUNT(*) AS n FROM units GROUP BY scene_id, status',
    ).all() as Row[]
    const stats: Record<string, { total: number; translated: number; pending: number }> = {}
    for (const r of rows) {
      const sceneId = String(r.scene_id || '(none)')
      const entry = stats[sceneId] ?? { total: 0, translated: 0, pending: 0 }
      const n = Number(r.n)
      entry.total += n
      if (String(r.status) === 'translated') entry.translated += n
      if (String(r.status) === 'pending') entry.pending += n
      stats[sceneId] = entry
    }
    return stats
  }

  // ---------------------------------------------------------------- terms

  upsertTerm(
    source: string,
    target: string,
    category = '',
    status = 'candidate',
    confidence = 'medium',
    evidence = '',
  ): void {
    this.db.prepare(
      'INSERT INTO terms(source, target, category, status, confidence, evidence, created_at)'
      + 'VALUES(?,?,?,?,?,?,?) '
      + 'ON CONFLICT(source, target) DO UPDATE SET '
      + 'status=excluded.status, confidence=excluded.confidence, evidence=excluded.evidence',
    ).run(source, target, category, status, confidence, evidence, now())
  }

  lockedTerms(): Array<Record<string, string>> {
    const rows = this.db.prepare(
      "SELECT source, target, category FROM terms WHERE status='locked' ORDER BY id",
    ).all() as Row[]
    return rows.map((r) => ({
      source: String(r.source),
      target: String(r.target),
      category: String(r.category),
    }))
  }

  /**
   * 已进入世界书流程的术语（proposed/covered/noinfo/error）：
   * 方案 C 的世界书种子候选来源之一——保留它们以便跳过记账与 force 重试；
   * rejected（worldbook_status 已清空）与 skip 天然不在其中，不再重复出卡。
   */
  engagedWorldbookTerms(): Array<Record<string, string>> {
    const rows = this.db.prepare(
      "SELECT source, target, category FROM terms"
      + " WHERE worldbook_status IN ('proposed','covered','noinfo','error') ORDER BY id",
    ).all() as Row[]
    return rows.map((r) => ({
      source: String(r.source),
      target: String(r.target),
      category: String(r.category),
    }))
  }

  pendingTerms(): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      "SELECT * FROM terms WHERE status='candidate' ORDER BY id",
    ).all() as Row[]
    return rows.map((r) => ({ ...r }))
  }

  decideTerm(term_id: number, status: string): boolean {
    if (status !== 'locked' && status !== 'rejected') return false
    const result = this.db.prepare(
      'UPDATE terms SET status=?, decided_at=? WHERE id=?',
    ).run(status, now(), term_id)
    return result.changes > 0
  }

  /** 更新术语译文/类别（状态变更请用 decideTerm）。 */
  updateTerm(term_id: number, target?: string | null, category?: string | null): boolean {
    const sets: string[] = []
    const values: any[] = []
    if (target != null) {
      sets.push('target=?')
      values.push(String(target))
    }
    if (category != null) {
      sets.push('category=?')
      values.push(String(category))
    }
    if (sets.length === 0) return false
    values.push(term_id)
    const result = this.db.prepare(
      `UPDATE terms SET ${sets.join(', ')} WHERE id=?`,
    ).run(...values)
    return result.changes > 0
  }

  /** 删除术语行（按 id）。 */
  deleteTerm(term_id: number): boolean {
    const result = this.db.prepare('DELETE FROM terms WHERE id=?').run(term_id)
    return result.changes > 0
  }

  /** 删除某源词的全部术语行（清理「一源多行」残留）。返回删除数。 */
  deleteTermsBySource(source: string): number {
    const result = this.db.prepare('DELETE FROM terms WHERE source=?').run(source)
    return result.changes
  }

  /**
   * 清空某源词的候选行（保留 locked/rejected）。
   * deliberation 落库前调用：upsert 冲突键是 (source,target)，占位行 (source,'')
   * 或旧候选不清理的话，改译名会新增行造成候选翻倍（S13）。
   */
  clearCandidateTermsBySource(source: string): number {
    const result = this.db.prepare("DELETE FROM terms WHERE source=? AND status='candidate'").run(source)
    return result.changes
  }

  /** 按源词取一行 id（优先锁定行），供「按 source 更新」定位（S10）。 */
  termIdBySource(source: string): number | null {
    const row = this.db.prepare(
      "SELECT id FROM terms WHERE source=? ORDER BY (status='locked') DESC, id LIMIT 1",
    ).get(source) as Row | undefined
    return row ? Number(row.id) : null
  }

  /** 全量术语（含 id），可按 status 过滤。 */
  allTerms(status?: string | null): Array<Record<string, unknown>> {
    let sql = 'SELECT * FROM terms'
    const params: any[] = []
    if (status) {
      sql += ' WHERE status=?'
      params.push(status)
    }
    sql += ' ORDER BY id'
    const rows = this.db.prepare(sql).all(...params) as Row[]
    return rows.map((r) => ({ ...r }))
  }

  /** 按源词+译文精确取一条术语（与 Python deliberation 的落库回查一致）。 */
  termBySourceTarget(source: string, target: string): Record<string, unknown> | null {
    const row = this.db.prepare(
      'SELECT * FROM terms WHERE source=? AND target=? LIMIT 1',
    ).get(source, target) as Row | undefined
    return row ? { ...row } : null
  }

  /** 确保术语行存在（不覆盖已有行的 target/status/confidence，供世界书记账用）。 */
  ensureTerm(source: string, category = ''): void {
    const row = this.db.prepare('SELECT id FROM terms WHERE source=? LIMIT 1').get(source) as Row | undefined
    if (row) return
    this.upsertTerm(source, '', category, 'candidate', 'medium')
  }

  /** 写世界书状态（source 可能有多行，全量更新；无该 source 的行则忽略）。 */
  setTermWorldbookStatus(source: string, status: string): void {
    this.db.prepare('UPDATE terms SET worldbook_status=? WHERE source=?').run(status, source)
  }

  /** 读世界书状态（无术语行/未标记时返回空串）。 */
  termWorldbookStatus(source: string): string {
    const row = this.db.prepare(
      'SELECT worldbook_status FROM terms WHERE source=? LIMIT 1',
    ).get(source) as Row | undefined
    return row ? String(row.worldbook_status ?? '') : ''
  }

  /** 术语表世界书状态计数（报表用）。 */
  worldbookStatusCounts(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT worldbook_status, COUNT(*) AS n FROM terms GROUP BY worldbook_status',
    ).all() as Row[]
    const counts: Record<string, number> = {}
    for (const r of rows) counts[String(r.worldbook_status ?? '')] = Number(r.n)
    return counts
  }

  // ---------------------------------------------------------------- worldbook

  saveWorldbook(entries: Array<Record<string, unknown>>): number {
    this.db.prepare('DELETE FROM worldbook_entries').run()
    const stmt = this.db.prepare(
      'INSERT INTO worldbook_entries'
      + '(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)'
      + "VALUES(?,?,?,?,?, 'confirmed', ?, 1, ?, ?)",
    )
    const ts = now()
    for (const e of entries) {
      stmt.run(
        String(e.kind ?? 'keyword'),
        String(e.title ?? ''),
        JSON.stringify(e.keywords ?? []),
        String(e.content ?? ''),
        JSON.stringify(e.source_refs ?? []),
        String(e.linked_term ?? ''),
        ts,
        ts,
      )
    }
    return entries.length
  }

  loadWorldbook(activeOnly = true): Array<Record<string, unknown>> {
    let sql = 'SELECT * FROM worldbook_entries'
    if (activeOnly) sql += " WHERE active=1 AND status='confirmed'"
    sql += ' ORDER BY id'
    const rows = this.db.prepare(sql).all() as Row[]
    return rows.map((r) => {
      const item = { ...r }
      item.keywords = parseJson<string[]>(String(item.keywords ?? ''), [])
      item.source_refs = parseJson<string[]>(String(item.source_refs ?? ''), [])
      return item
    })
  }

  updateWorldbookEntry(entry_id: number, fields: Record<string, unknown>): boolean {
    const allowed = new Set(['kind', 'title', 'content', 'active', 'keywords', 'source_refs'])
    allowed.add('status')
    allowed.add('linked_term')
    const sets: string[] = []
    const values: any[] = []
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.has(key)) continue
      if ((key === 'keywords' || key === 'source_refs') && Array.isArray(value)) {
        values.push(JSON.stringify(value))
      } else {
        values.push(value)
      }
      sets.push(`${key}=?`)
    }
    if (sets.length === 0) return false
    values.push(now(), entry_id)
    const result = this.db.prepare(
      `UPDATE worldbook_entries SET ${sets.join(', ')}, updated_at=? WHERE id=?`,
    ).run(...values)
    return result.changes > 0
  }

  /** 世界书条目全量（含 proposed，供编辑/列表用）；软删（active=0）不返回。 */
  listWorldbook(status?: string | null): Array<Record<string, unknown>> {
    let sql = 'SELECT * FROM worldbook_entries WHERE active=1'
    const params: any[] = []
    if (status) {
      sql += ' AND status=?'
      params.push(status)
    }
    sql += ' ORDER BY id'
    const rows = this.db.prepare(sql).all(...params) as Row[]
    return rows.map((r) => {
      const item = { ...r }
      item.keywords = parseJson<string[]>(String(item.keywords ?? ''), [])
      item.source_refs = parseJson<string[]>(String(item.source_refs ?? ''), [])
      return item
    })
  }

  /** 幂等提案：同 (kind,title) 已有 active 条目则跳过；新条目以 proposed 入库。 */
  proposeWorldbook(entries: Array<Record<string, unknown>>): number {
    const exists = this.db.prepare(
      'SELECT 1 FROM worldbook_entries WHERE kind=? AND title=? AND active=1 LIMIT 1',
    )
    const stmt = this.db.prepare(
      'INSERT INTO worldbook_entries'
      + '(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)'
      + "VALUES(?,?,?,?,?, 'proposed', ?, 1, ?, ?)",
    )
    const ts = now()
    let count = 0
    for (const e of entries) {
      const kind = String(e.kind ?? 'keyword')
      const title = String(e.title ?? '').trim()
      if (!title) continue
      if (exists.get(kind, title)) continue
      stmt.run(
        kind,
        title,
        JSON.stringify(e.keywords ?? []),
        String(e.content ?? ''),
        JSON.stringify(e.source_refs ?? []),
        String(e.linked_term ?? ''),
        ts,
        ts,
      )
      count += 1
    }
    return count
  }

  /** 术语驱动提案：按 linked_term 幂等 upsert（一个术语只留一条，重跑更新而非新增），并回写术语状态 proposed。 */
  proposeWorldbookByTerm(entries: Array<Record<string, unknown>>): number {
    const sel = this.db.prepare(
      'SELECT id FROM worldbook_entries WHERE linked_term=? AND active=1 LIMIT 1',
    )
    const ins = this.db.prepare(
      'INSERT INTO worldbook_entries'
      + '(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)'
      + "VALUES(?,?,?,?,?, 'proposed', ?, 1, ?, ?)",
    )
    const upd = this.db.prepare(
      "UPDATE worldbook_entries SET kind=?, title=?, keywords=?, content=?, source_refs=?, status='proposed', active=1, updated_at=? WHERE id=?",
    )
    const ts = now()
    let count = 0
    for (const e of entries) {
      const linked = String(e.linked_term ?? '').trim()
      const title = String(e.title ?? '').trim()
      if (!linked || !title) continue
      const kind = String(e.kind ?? 'keyword')
      const keywords = JSON.stringify(e.keywords ?? [])
      const content = String(e.content ?? '')
      const sourceRefs = JSON.stringify(e.source_refs ?? [])
      const existing = sel.get(linked) as Row | undefined
      if (existing) {
        upd.run(kind, title, keywords, content, sourceRefs, ts, existing.id)
      } else {
        ins.run(kind, title, keywords, content, sourceRefs, linked, ts, ts)
      }
      this.setTermWorldbookStatus(linked, 'proposed')
      count += 1
    }
    return count
  }

  /** 确认条目（proposed → confirmed）。 */
  confirmWorldbook(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const r = this.db.prepare(
      `UPDATE worldbook_entries SET status='confirmed', active=1, updated_at=? WHERE id IN (${placeholders})`,
    ).run(now(), ...ids)
    if (r.changes > 0) {
      const rows = this.db.prepare(
        `SELECT DISTINCT linked_term FROM worldbook_entries WHERE id IN (${placeholders}) AND linked_term != ''`,
      ).all(...ids) as Row[]
      for (const row of rows) this.setTermWorldbookStatus(String(row.linked_term), 'covered')
    }
    return r.changes
  }

  /** 拒绝/删除条目（软删：active=0 + status='rejected'）。 */
  rejectWorldbook(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const r = this.db.prepare(
      `UPDATE worldbook_entries SET status='rejected', active=0, updated_at=? WHERE id IN (${placeholders})`,
    ).run(now(), ...ids)
    if (r.changes > 0) {
      const rows = this.db.prepare(
        `SELECT DISTINCT linked_term FROM worldbook_entries WHERE id IN (${placeholders}) AND linked_term != ''`,
      ).all(...ids) as Row[]
      for (const row of rows) this.setTermWorldbookStatus(String(row.linked_term), '')
    }
    return r.changes
  }

  /** 取一批条目的关联术语 source（软删前调用，供 delete+skipTerm 标定 skip）。 */
  worldbookLinkedTerms(ids: number[]): string[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT DISTINCT linked_term FROM worldbook_entries WHERE id IN (${placeholders}) AND linked_term != '' AND active=1`,
    ).all(...ids) as Row[]
    return rows.map((r) => String(r.linked_term))
  }

  /** 手工新增一条世界书条目（默认 confirmed）。 */
  addWorldbookEntry(entry: Record<string, unknown>): number {
    const result = this.db.prepare(
      'INSERT INTO worldbook_entries'
      + '(kind, title, keywords, content, source_refs, status, linked_term, active, created_at, updated_at)'
      + "VALUES(?,?,?,?,?, 'confirmed', ?, 1, ?, ?)",
    ).run(
      String(entry.kind ?? 'lore'),
      String(entry.title ?? '').trim(),
      JSON.stringify(entry.keywords ?? []),
      String(entry.content ?? ''),
      JSON.stringify(entry.source_refs ?? []),
      String(entry.linked_term ?? ''),
      now(),
      now(),
    )
    return Number(result.lastInsertRowid)
  }

  /** 术语↔世界书译名一致性：linked_term 指向的锁定术语译名与世界书条目标题冲突时列出。 */
  worldbookTermConflicts(): Array<{
    term: string
    termTarget: string
    entryId: number
    entryTitle: string
  }> {
    const locked = this.lockedTerms()
    const entries = this.listWorldbook('confirmed')
    const out: Array<{ term: string; termTarget: string; entryId: number; entryTitle: string }> = []
    for (const e of entries) {
      const linked = String(e.linked_term ?? '').trim()
      if (!linked) continue
      const term = locked.find((t) => t.source === linked)
      if (term && String(e.title ?? '').trim() !== term.target) {
        out.push({
          term: linked,
          termTarget: term.target ?? '',
          entryId: Number(e.id),
          entryTitle: String(e.title ?? ''),
        })
      }
    }
    return out
  }

  // ---------------------------------------------------------------- characters

  upsertCharacter(speaker: string, name_zh = '', aliases = ''): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO characters(speaker, name_zh, aliases, first_seen)'
      + 'VALUES(?,?,?,?)',
    ).run(speaker, name_zh, aliases, now())
    if (name_zh) {
      this.db.prepare(
        "UPDATE characters SET name_zh=? WHERE speaker=? AND name_zh=''",
      ).run(name_zh, speaker)
    }
  }

  getCharacters(): Record<string, Record<string, unknown>> {
    const rows = this.db.prepare('SELECT * FROM characters ORDER BY speaker').all() as Row[]
    const out: Record<string, Record<string, unknown>> = {}
    for (const r of rows) out[String(r.speaker)] = { ...r }
    return out
  }

  setCharacterStyle(speaker: string, note: string): void {
    this.db.prepare('UPDATE characters SET style_notes=? WHERE speaker=?').run(note, speaker)
  }

  // ------------------------------------------------- understanding / summaries

  saveUnderstanding(record: UnderstandingRecord, branch = 'main'): void {
    this.db.prepare(
      'INSERT INTO scene_understandings(scene_id, branch, record, created_at) '
      + 'VALUES(?,?,?,?) '
      + 'ON CONFLICT(scene_id) DO UPDATE SET branch=excluded.branch, '
      + 'record=excluded.record, created_at=excluded.created_at',
    ).run(record.scene_id, branch, JSON.stringify(record.toDict()), now())
  }

  /** 全部场景理解记录（record 已解析为 dict）。 */
  allUnderstandings(): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      'SELECT scene_id, branch, record, created_at '
      + 'FROM scene_understandings ORDER BY rowid',
    ).all() as Row[]
    return rows.map((r) => ({
      scene_id: r.scene_id,
      branch: r.branch,
      record: parseJson(String(r.record ?? ''), {}),
      created_at: r.created_at,
    }))
  }

  /** 场景内单元及其译文（TM 按 source_hash+unit_id 唯一关联）。 */
  unitsWithTranslations(scene_id: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      'SELECT u.unit_id, u.kind, u.source, u.markup, u.speaker, u.status, '
      + "COALESCE(t.translation, '') AS translation "
      + 'FROM units u LEFT JOIN tm t '
      + 'ON t.source_hash = u.source_hash AND t.unit_id = u.unit_id '
      + 'WHERE u.scene_id=? ORDER BY u.rowid',
    ).all(scene_id) as Row[]
    return rows.map((r) => ({ ...r }))
  }

  getUnderstanding(scene_id: string): UnderstandingRecord | null {
    const row = this.db.prepare(
      'SELECT record FROM scene_understandings WHERE scene_id=?',
    ).get(scene_id) as Row | undefined
    if (!row) return null
    return UnderstandingRecord.fromDict(parseJson(String(row.record ?? ''), {}))
  }

  recentUnderstandings(branch: string, limit = 5): UnderstandingRecord[] {
    const rows = this.db.prepare(
      'SELECT record FROM scene_understandings WHERE branch=? '
      + 'ORDER BY rowid DESC LIMIT ?',
    ).all(branch, limit) as Row[]
    const records = rows.map((r) =>
      UnderstandingRecord.fromDict(parseJson(String(r.record ?? ''), {})))
    return records.reverse()
  }

  getSummary(branch = 'main'): string {
    const row = this.db.prepare(
      'SELECT summary FROM branch_summaries WHERE branch=?',
    ).get(branch) as Row | undefined
    return row ? String(row.summary) : ''
  }

  saveSummary(branch: string, summary: string, position: number): void {
    this.db.prepare(
      'INSERT INTO branch_summaries(branch, summary, position, updated_at) '
      + 'VALUES(?,?,?,?) '
      + 'ON CONFLICT(branch) DO UPDATE SET summary=excluded.summary, '
      + 'position=excluded.position, updated_at=excluded.updated_at',
    ).run(branch, summary, position, now())
  }

  // ---------------------------------------------------------------- tm

  /** 取同源译文：context_fp 为空取最高命中（few-shot 用）；给定则精确匹配上下文指纹。 */
  tmGet(source: string, context_fp?: string | null): string {
    let row: Row | undefined
    if (context_fp == null) {
      row = this.db.prepare(
        'SELECT translation FROM tm WHERE source_hash=? ORDER BY hits DESC LIMIT 1',
      ).get(sourceHash(source)) as Row | undefined
    } else {
      row = this.db.prepare(
        'SELECT translation FROM tm WHERE source_hash=? AND context_fp=? '
        + 'ORDER BY hits DESC LIMIT 1',
      ).get(sourceHash(source), context_fp) as Row | undefined
    }
    return row ? String(row.translation) : ''
  }

  tmPut(source: string, unit_id: string, translation: string, context_fp = ''): void {
    this.db.prepare(
      'INSERT INTO tm(source_hash, unit_id, translation, context_fp, hits) '
      + 'VALUES(?,?,?,?,1) '
      + 'ON CONFLICT(source_hash, unit_id) DO UPDATE SET '
      + 'translation=excluded.translation, context_fp=excluded.context_fp, hits=hits+1',
    ).run(sourceHash(source), unit_id, translation, context_fp)
  }

  /** 最近常用译文（few-shot 用），返回 [context, translation] 对。 */
  tmRecent(limit = 50): Array<[string, string]> {
    const rows = this.db.prepare(
      'SELECT translation FROM tm ORDER BY hits DESC, rowid DESC LIMIT ?',
    ).all(limit) as Row[]
    return rows.map((r) => ['', String(r.translation)])
  }

  /** 全量已译译文：units JOIN tm（同源+同单元），返回 unit_id -> 译文。
   *  累计全量回写（Ren'Py tl 增量写；有译文即返回，不依赖单元状态，审校待回填也覆盖）。 */
  allTranslations(): Record<string, string> {
    const rows = this.db.prepare(
      'SELECT u.unit_id, t.translation FROM units u '
      + 'JOIN tm t ON t.source_hash = u.source_hash AND t.unit_id = u.unit_id '
      + "WHERE t.translation != '' ORDER BY u.rowid",
    ).all() as Row[]
    const out: Record<string, string> = {}
    for (const r of rows) out[String(r.unit_id)] = String(r.translation)
    return out
  }

  // ------------------------------------------------ proposals / approval queue

  addProposal(kind: string, payload: Record<string, unknown>): number {
    const result = this.db.prepare(
      "INSERT INTO proposals(kind, payload, status, created_at) VALUES(?,?, 'pending', ?)",
    ).run(kind, JSON.stringify(payload), now())
    return Number(result.lastInsertRowid)
  }

  pendingProposals(): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      "SELECT * FROM proposals WHERE status='pending' ORDER BY id",
    ).all() as Row[]
    return rows.map((r) => {
      const item = { ...r }
      item.payload = parseJson(String(item.payload ?? ''), {})
      return item
    })
  }

  decideProposal(proposal_id: number, status: string): boolean {
    if (status !== 'approved' && status !== 'rejected') return false
    const result = this.db.prepare(
      'UPDATE proposals SET status=?, decided_at=? WHERE id=?',
    ).run(status, now(), proposal_id)
    return result.changes > 0
  }

  addApproval(kind: string, payload: Record<string, unknown>): number {
    const result = this.db.prepare(
      "INSERT INTO approval_queue(kind, payload, status, created_at) VALUES(?,?, 'pending', ?)",
    ).run(kind, JSON.stringify(payload), now())
    return Number(result.lastInsertRowid)
  }

  pendingApprovals(): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      "SELECT * FROM approval_queue WHERE status='pending' ORDER BY id",
    ).all() as Row[]
    return rows.map((r) => {
      const item = { ...r }
      item.payload = parseJson(String(item.payload ?? ''), {})
      return item
    })
  }

  approvalById(approval_id: number): Record<string, unknown> | null {
    const row = this.db.prepare(
      'SELECT * FROM approval_queue WHERE id=?',
    ).get(approval_id) as Row | undefined
    if (!row) return null
    const item = { ...row }
    item.payload = parseJson(String(item.payload ?? ''), {})
    return item
  }

  decideApproval(approval_id: number, status: string): boolean {
    if (status !== 'approved' && status !== 'rejected') return false
    const result = this.db.prepare(
      'UPDATE approval_queue SET status=?, decided_at=? WHERE id=?',
    ).run(status, now(), approval_id)
    return result.changes > 0
  }

  /** 审批队列中是否存在同类且 source 匹配的待审批项（入队幂等）。 */
  pendingApprovalExists(kind: string, source: string): boolean {
    const rows = this.db.prepare(
      "SELECT payload FROM approval_queue WHERE kind=? AND status='pending'",
    ).all(kind) as Row[]
    return rows.some((row) => {
      const payload = parseJson<Record<string, unknown>>(String(row.payload ?? ''), {})
      return String(payload.source ?? '') === source
    })
  }

  // ------------------------------------------------------------ runs / usage

  beginRun(run_id: string, kind: string): void {
    this.db.prepare(
      "INSERT INTO runs(run_id, kind, status, started_at) VALUES(?,?, 'running', ?)",
    ).run(run_id, kind, now())
    this.db.prepare('INSERT OR IGNORE INTO usage(run_id) VALUES(?)').run(run_id)
  }

  finishRun(run_id: string, summary = ''): void {
    this.db.prepare(
      "UPDATE runs SET status='done', summary=?, finished_at=? WHERE run_id=?",
    ).run(summary, now(), run_id)
  }

  failRun(run_id: string, summary = ''): void {
    this.db.prepare(
      "UPDATE runs SET status='error', summary=?, finished_at=? WHERE run_id=?",
    ).run(summary, now(), run_id)
  }

  addUsage(
    run_id: string,
    calls = 0,
    prompt_tokens = 0,
    completion_tokens = 0,
    elapsed_seconds = 0,
  ): void {
    this.db.prepare(
      'INSERT INTO usage(run_id, calls, prompt_tokens, completion_tokens, '
      + 'total_tokens, elapsed_seconds) VALUES(?,?,?,?,?,?) '
      + 'ON CONFLICT(run_id) DO UPDATE SET '
      + 'calls=calls+excluded.calls, prompt_tokens=prompt_tokens+excluded.prompt_tokens, '
      + 'completion_tokens=completion_tokens+excluded.completion_tokens, '
      + 'total_tokens=total_tokens+excluded.total_tokens, '
      + 'elapsed_seconds=elapsed_seconds+excluded.elapsed_seconds',
    ).run(
      run_id,
      calls,
      prompt_tokens,
      completion_tokens,
      prompt_tokens + completion_tokens,
      elapsed_seconds,
    )
  }

  usageFor(run_id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM usage WHERE run_id=?').get(run_id) as Row | undefined
    return row ? { ...row } : {}
  }

  /** 全部 usage 记录的聚合（报表成本面板用；无数据时全 0）。 */
  usageTotals(): UsageTotals {
    const row = this.db.prepare(
      'SELECT COUNT(run_id) AS runs, '
      + 'COALESCE(SUM(calls), 0) AS calls, '
      + 'COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, '
      + 'COALESCE(SUM(completion_tokens), 0) AS completion_tokens, '
      + 'COALESCE(SUM(total_tokens), 0) AS total_tokens, '
      + 'COALESCE(SUM(elapsed_seconds), 0) AS elapsed_seconds '
      + 'FROM usage',
    ).get() as Row
    return {
      runs: Number(row.runs),
      calls: Number(row.calls),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      elapsedSeconds: Number(row.elapsed_seconds),
    }
  }

  recentRuns(limit = 20): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      'SELECT * FROM runs ORDER BY rowid DESC LIMIT ?',
    ).all(limit) as Row[]
    return rows.map((r) => ({ ...r }))
  }

  runById(run_id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(run_id) as Row | undefined
    return row ? { ...row } : null
  }

  // ------------------------------------------------------------ search cache

  searchCacheGet(query_hash: string): Array<Record<string, unknown>> | null {
    const row = this.db.prepare(
      'SELECT results FROM search_cache WHERE query_hash=?',
    ).get(query_hash) as Row | undefined
    if (!row) return null
    return parseJson<Array<Record<string, unknown>>>(String(row.results ?? ''), [])
  }

  searchCachePut(
    query_hash: string,
    engine: string,
    query: string,
    results: Array<Record<string, unknown>>,
  ): void {
    this.db.prepare(
      'INSERT INTO search_cache(query_hash, engine, query, results, created_at) '
      + 'VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(query_hash) DO UPDATE SET results=excluded.results',
    ).run(query_hash, engine, query, JSON.stringify(results), now())
  }
}
