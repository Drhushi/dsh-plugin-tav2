/**
 * tav2_migrate 核心对账（src/core，不依赖 dsh / 引擎模型）。
 *
 * 游戏更新后：以稳定 unit_id（Ren'Py 官方 md5 id）为主匹配、规范化原文哈希兜底，
 * 把旧版本单元分类为 unchanged / changed / added / removed，并计算「不匹配率」
 * （旧单元中既未按 unit_id 命中、也未按兜底哈希命中的占比）供 5% 阈值闸门使用。
 * 重译不在此层：changed/added 由调用方标 pending 后交给 translate_batch。
 */
import { createHash } from 'node:crypto'

export type MigrationKind = 'unchanged' | 'changed' | 'added' | 'removed'

/** 迁移计划中的一行。 */
export interface MigrationRow {
  kind: MigrationKind
  /** 新版本 unit_id（removed 时为旧 unit_id）。 */
  unitId: string
  /** 新版本原文（removed 时为旧原文）。 */
  source: string
  /** 兜底匹配时的旧 unit_id（unit_id 变化但原文一致）。 */
  oldUnitId?: string
  /** 说明（changed=原文变化；兜底=unit_id 变化但原文一致）。 */
  reason?: string
}

/** 一份完整的迁移计划（纯数据，可 JSON 序列化展示给用户）。 */
export interface MigrationPlan {
  unchanged: MigrationRow[]
  changed: MigrationRow[]
  added: MigrationRow[]
  removed: MigrationRow[]
  /** 不匹配率 = 未命中旧单元数 / 旧单元总数（0..1）。 */
  unmatchedRate: number
  oldTotal: number
  newTotal: number
}

/** 迁移对账的最小输入形状（引擎模型在调用方转成这个）。 */
export interface PlainUnit {
  unit_id: string
  source: string
}

/** 不匹配率阈值：超过则拒绝自动迁移（fail-closed）。 */
export const MAX_UNMATCHED_RATE = 0.05

/** 规范化原文：去首尾空白 + 内部空白折叠（换行/多空格视为同原文）。 */
export function normalizeSource(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** 兜底匹配键：规范化原文的 sha256（unit_id 变了但文本没变也能对上）。 */
export function fallbackKey(text: string): string {
  return createHash('sha256').update(normalizeSource(text), 'utf8').digest('hex')
}

/** 不匹配率是否在安全阈值内。 */
export function isMigrationSafe(plan: MigrationPlan): boolean {
  return plan.unmatchedRate <= MAX_UNMATCHED_RATE
}

/**
 * 对账：把旧版本单元与新版本单元分类。
 * - unchanged：同 unit_id 且规范化原文一致，或兜底哈希一致（oldUnitId 记录旧 id）
 * - changed：同 unit_id 但原文变化
 * - added：新版新增、无任何旧单元命中
 * - removed：旧版有、新版无任何命中（计入不匹配率）
 */
export function planMigration(oldUnits: PlainUnit[], newUnits: PlainUnit[]): MigrationPlan {
  const newById = new Map<string, { source: string; normalized: string }>()
  for (const nu of newUnits) {
    newById.set(nu.unit_id, { source: nu.source, normalized: normalizeSource(nu.source) })
  }

  const used = new Set<string>()
  const unchanged: MigrationRow[] = []
  const changed: MigrationRow[] = []
  const leftoverOld: PlainUnit[] = []

  // pass 1：按 unit_id 主匹配
  for (const old of oldUnits) {
    const hit = newById.get(old.unit_id)
    if (!hit) {
      leftoverOld.push(old)
      continue
    }
    used.add(old.unit_id)
    if (hit.normalized === normalizeSource(old.source)) {
      unchanged.push({ kind: 'unchanged', unitId: old.unit_id, source: hit.source })
    } else {
      changed.push({
        kind: 'changed',
        unitId: old.unit_id,
        source: hit.source,
        reason: '原文变化，待重译',
      })
    }
  }

  // pass 2：兜底按规范化原文哈希匹配（只匹配未被 unit_id 命中的新单元，一一对应）
  const newByFallback = new Map<string, string>()
  for (const nu of newUnits) {
    if (used.has(nu.unit_id)) continue
    const key = fallbackKey(nu.source)
    if (!newByFallback.has(key)) newByFallback.set(key, nu.unit_id)
  }
  const removed: MigrationRow[] = []
  for (const old of leftoverOld) {
    const key = fallbackKey(old.source)
    const matchId = newByFallback.get(key)
    if (matchId && !used.has(matchId)) {
      used.add(matchId)
      const hit = newById.get(matchId)!
      unchanged.push({
        kind: 'unchanged',
        unitId: matchId,
        source: hit.source,
        oldUnitId: old.unit_id,
        reason: 'unit_id 变化但原文一致，译文携行',
      })
    } else {
      removed.push({ kind: 'removed', unitId: old.unit_id, source: old.source })
    }
  }

  // pass 3：added（未被任何旧单元命中的新单元）
  const added: MigrationRow[] = []
  for (const nu of newUnits) {
    if (!used.has(nu.unit_id)) {
      added.push({ kind: 'added', unitId: nu.unit_id, source: nu.source })
    }
  }

  const oldTotal = oldUnits.length
  const newTotal = newUnits.length
  const unmatchedRate = oldTotal === 0 ? 0 : removed.length / oldTotal

  return { unchanged, changed, added, removed, unmatchedRate, oldTotal, newTotal }
}
