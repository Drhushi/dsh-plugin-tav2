/**
 * 术语链路（与 Python tav2/terms.py 对齐）：
 * 候选入库、批量锁定、高置信自动锁定。
 */

import type { ProjectDB } from './db'
import type { ScanCandidate } from './scanning'

/** 把快筛候选写入 DB（status=candidate，不去重已存在项）。返回新增数。 */
export function seedTerms(db: ProjectDB, candidates: ScanCandidate[]): number {
  const existing = new Set(
    db.pendingTerms()
      .map((row) => String(row.source ?? ''))
      .filter(Boolean),
  )
  let count = 0
  for (const cand of candidates) {
    const source = cand.source.trim()
    if (!source || existing.has(source)) continue
    // 方案 A 后扫描只出专名（name/allcaps），类别统一记 name。
    db.upsertTerm(source, '', 'name', 'candidate', 'medium')
    existing.add(source)
    count += 1
  }
  return count
}

/** 批量锁定译名（源词, 译词, 类别）。返回锁定数。 */
export function lockTerms(db: ProjectDB, items: Array<[string, string, string]>): number {
  let count = 0
  for (const [source, target, category] of items) {
    if (!source.trim() || !target.trim()) continue
    db.upsertTerm(source, target, category, 'locked', 'human')
    count += 1
  }
  return count
}

/** 把高置信且已产出译文的候选自动锁定（由 deliberation 写入后调用）。 */
export function autoLockHighConfidence(db: ProjectDB): number {
  let locked = 0
  for (const row of db.pendingTerms()) {
    if (row.confidence !== 'high' || !String(row.target ?? '')) continue
    const id = Number(row.id)
    if (Number.isFinite(id) && db.decideTerm(id, 'locked')) locked += 1
  }
  return locked
}
