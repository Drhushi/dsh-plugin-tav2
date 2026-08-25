/**
 * tav2_migrate：游戏更新后的增量迁移工具（审批写操作）。
 *
 * 流程：读 config 的 game_dir（=新版本）→ 与 DB 旧指纹比对（未变化则 no-op）→
 * 提取新版本文档 → 与 DB 旧单元对账（src/core/migrate）→ 不匹配率 >5% 则
 * fail-closed 拒绝并出人工报告 → 审批通过后应用（同步单元、changed/added 标
 * pending、removed 标 removed、兜底携译文、写新指纹快照、归档旧补丁产物）。
 * 重译不在此工具：changed/added 交给既有 translate_batch。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Config } from '../config'
import { approvalDenialText, requestApproval, type ApprovalDecision } from '../core/approval'
import {
  computeGameFingerprint,
  fingerprintChanged,
  readFingerprintSnapshot,
  storeFingerprintSnapshot,
  type GameFingerprint,
} from '../core/fingerprint'
import {
  isMigrationSafe,
  planMigration,
  type MigrationPlan,
  type PlainUnit,
} from '../core/migrate'
import type { Tav2ToolResult } from '../core/types'
import { renpyAdapter } from '../engine/adapters'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'
import type { Document } from '../engine/models'

/** 迁移应用结果。 */
export interface MigrateApplied {
  syncedUnits: number
  pending: string[]
  removed: string[]
  carried: number
  archivedFrom?: string
  archivedTo?: string
}

/** 可注入接缝（离线测试用）：指纹计算、文档提取、审批。 */
export interface MigrateToolOptions {
  approve?: (plan: MigrationPlan) => Promise<ApprovalDecision>
  runtime?: {
    fingerprint?: (engine: string, gameRoot: string) => GameFingerprint
    extract?: (gameRoot: string, lang: string) => Document
  }
}

/** 把显示版本压成安全目录名。 */
function sanitizeVersion(displayVersion: string): string {
  const clean = displayVersion.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
  return clean || 'unknown'
}

/** 递归把 from 移入 to（目标已存在时合并目录 / 文件冲突保留原文件不覆盖）。 */
function moveInto(from: string, to: string): void {
  if (existsSync(to)) {
    const fromStat = statSync(from)
    const toStat = statSync(to)
    if (fromStat.isDirectory() && toStat.isDirectory()) {
      for (const entry of readdirSync(from)) {
        moveInto(join(from, entry), join(to, entry))
      }
      rmIfEmpty(from)
      return
    }
    // 文件/目录冲突：保留旧归档（不覆盖），源留在原位
    return
  }
  renameSync(from, to)
}

function rmIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
}

/** 把 patch/<游戏名>/ 旧产物归档到 patch/archive/<版本>/<游戏名>/（无产物则跳过）。 */
export function archiveOldPatch(
  projectDir: string,
  gameName: string,
  displayVersion: string,
): { archivedFrom?: string; archivedTo?: string } {
  const patchRoot = join(projectDir, 'patch', gameName)
  if (!existsSync(patchRoot) || !statSync(patchRoot).isDirectory()) return {}
  const entries = readdirSync(patchRoot)
  if (entries.length === 0) return {}
  const archiveRoot = join(projectDir, 'patch', 'archive', sanitizeVersion(displayVersion), gameName)
  mkdirSync(archiveRoot, { recursive: true })
  for (const entry of entries) {
    moveInto(join(patchRoot, entry), join(archiveRoot, entry))
  }
  rmIfEmpty(patchRoot)
  return { archivedFrom: patchRoot, archivedTo: archiveRoot }
}

function planSummary(plan: MigrationPlan): string {
  return [
    `未变 ${plan.unchanged.length}（保留译文）`,
    `待重译 ${plan.changed.length}（原文变化）`,
    `待新译 ${plan.added.length}（新增）`,
    `移除 ${plan.removed.length}（标 removed，不删除）`,
  ].join('，')
}

function renderPlan(plan: MigrationPlan, fromVer: string, toVer: string): string {
  const lines = [
    `迁移计划 ${fromVer} → ${toVer}（${planSummary(plan)}）`,
    `不匹配率 ${(plan.unmatchedRate * 100).toFixed(2)}%（阈值 5%）`,
  ]
  if (plan.changed.length > 0) {
    lines.push('待重译示例：', ...plan.changed.slice(0, 5).map((r) => `  ~ ${r.unitId}: ${r.source}`))
  }
  if (plan.added.length > 0) {
    lines.push('待新译示例：', ...plan.added.slice(0, 5).map((r) => `  + ${r.unitId}: ${r.source}`))
  }
  if (plan.removed.length > 0) {
    lines.push('移除示例：', ...plan.removed.slice(0, 5).map((r) => `  - ${r.unitId}`))
  }
  return lines.join('\n')
}

function renderUnsafe(plan: MigrationPlan, fromVer: string, toVer: string): string {
  const lines = [
    `迁移被拒绝（fail-closed）：不匹配率 ${(plan.unmatchedRate * 100).toFixed(2)}% 超过阈值 5%。`,
    '可能原因：游戏大规模重写 / 提取结构变化 / game_dir 指向错误。',
    '未做任何写入。请人工核对以下无法匹配的旧单元（示例前 20 条）：',
  ]
  for (const row of plan.removed.slice(0, 20)) {
    lines.push(`  - ${row.unitId}: ${row.source}`)
  }
  return lines.join('\n')
}

/**
 * 执行迁移。approve 回调收到迁移计划（审批文案可用计划摘要）；未注入时按不可用拒绝
 * （工具注册层用 requestApproval 注入真实审批）。
 */
export async function runTsMigrate(
  config: Config,
  opts: MigrateToolOptions = {},
): Promise<Tav2ToolResult & { plan?: MigrationPlan; applied?: MigrateApplied }> {
  const approve = opts.approve ?? (async () => 'unavailable' as ApprovalDecision)
  const computeFp = opts.runtime?.fingerprint ?? computeGameFingerprint
  const extract =
    opts.runtime?.extract ??
    ((gameRoot: string, lang: string) => renpyAdapter.extract(gameRoot, { lang }).document)

  let engineCfg
  try {
    engineCfg = loadEngineConfigFor(config)
  } catch (err) {
    return { ok: false, command: 'migrate', text: `读取引擎配置失败：${String(err)}`, timedOut: false }
  }
  if (!engineCfg.gameDir) {
    return { ok: false, command: 'migrate', text: 'config.yaml 未配置 game_dir（新版本游戏根目录）', timedOut: false }
  }

  const dbPath = resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir)
  const db = new ProjectDB(dbPath)
  try {
    const oldFp = readFingerprintSnapshot(db)
    if (!oldFp) {
      return {
        ok: false,
        command: 'migrate',
        text: '未找到旧版本指纹快照，请先运行 tav2_fingerprint snapshot（本插件只支持有指纹基线的增量迁移）',
        timedOut: false,
      }
    }

    let newFp: GameFingerprint
    try {
      newFp = computeFp(engineCfg.engine, engineCfg.gameDir)
    } catch (err) {
      return { ok: false, command: 'migrate', text: `计算新版本指纹失败：${String(err)}`, timedOut: false }
    }
    if (!fingerprintChanged(oldFp, newFp)) {
      return {
        ok: true,
        command: 'migrate',
        text: `版本未变化（显示版本 ${newFp.displayVersion}，指纹一致），无需迁移（no-op）`,
        timedOut: false,
      }
    }

    let newDoc: Document
    try {
      newDoc = extract(engineCfg.gameDir, engineCfg.lang)
    } catch (err) {
      return { ok: false, command: 'migrate', text: `提取新版本失败：${String(err)}`, timedOut: false }
    }
    const newUnits: PlainUnit[] = newDoc.allUnits().map((u) => ({ unit_id: u.unit_id, source: u.source }))
    // 对账基线 = 当前存活的单元（排除历史 removed，避免多轮迁移累积误触阈值）
    const oldUnits: PlainUnit[] = db
      .allUnits()
      .filter((u) => u.status !== 'removed')
      .map((u) => ({ unit_id: u.unit_id, source: u.source }))
    const plan = planMigration(oldUnits, newUnits)

    if (!isMigrationSafe(plan)) {
      return {
        ok: false,
        command: 'migrate',
        text: renderUnsafe(plan, oldFp.displayVersion, newFp.displayVersion),
        timedOut: false,
        plan,
      }
    }

    const decision = await approve(plan)
    if (decision !== 'allowed') {
      return {
        ok: false,
        command: 'migrate',
        text: `迁移计划未获批准：${approvalDenialText(decision)}（未做任何写入）\n${renderPlan(plan, oldFp.displayVersion, newFp.displayVersion)}`,
        timedOut: false,
        plan,
      }
    }

    // ---- 应用 ----
    const syncedUnits = db.syncUnits(newDoc)
    // changed：更新原文 + 标 pending
    for (const row of plan.changed) db.updateUnitSource(row.unitId, row.source)
    db.setUnitStatuses(plan.changed.map((r) => r.unitId), 'pending')
    // added：标 pending（新行默认已 pending，显式一遍保持一致）
    db.setUnitStatuses(plan.added.map((r) => r.unitId), 'pending')
    // 兜底携译文：unit_id 变化但原文一致的 unchanged → 译文迁到新 unit_id，标 translated；
    // 旧 id 在新版本已不存在，标 removed 归档（避免残留计入存活单元/覆盖率）。
    let carried = 0
    for (const row of plan.unchanged) {
      if (!row.oldUnitId) continue
      const translation = db.unitTranslation(row.oldUnitId)
      if (translation) {
        db.tmPut(row.source, row.unitId, translation, '')
        db.setUnitStatus(row.unitId, 'translated')
        carried += 1
      }
      db.setUnitStatus(row.oldUnitId, 'removed')
    }
    // removed：标 removed（tm 保留，孤儿数据无害）
    const removedIds = plan.removed.map((r) => r.unitId)
    db.setUnitStatuses(removedIds, 'removed')
    // 写新指纹快照（current + history + work/fingerprint.json）
    storeFingerprintSnapshot(db, config.projectDir, newFp)
    // 归档旧补丁产物
    const gameName = basename(engineCfg.gameDir) || 'game'
    const archived = archiveOldPatch(config.projectDir, gameName, newFp.displayVersion)

    const applied: MigrateApplied = {
      syncedUnits,
      pending: [...plan.changed.map((r) => r.unitId), ...plan.added.map((r) => r.unitId)],
      removed: removedIds,
      carried,
      archivedFrom: archived.archivedFrom,
      archivedTo: archived.archivedTo,
    }
    const archiveLine = archived.archivedTo
      ? `\n旧补丁已归档：${archived.archivedFrom} → ${archived.archivedTo}`
      : '\n无旧补丁产物，跳过归档'
    const text =
      `迁移完成 ${oldFp.displayVersion} → ${newFp.displayVersion}（${planSummary(plan)}）`
      + `\n待重译 ${applied.pending.length} 个单元，请运行 translate_batch 重译`
      + archiveLine
    return { ok: true, command: 'migrate', text, timedOut: false, plan, applied }
  } finally {
    db.close()
  }
}

export function registerMigrateTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_migrate',
    description:
      '游戏更新后增量迁移：按稳定单元 id 对账新旧版本，保留未变译文、标记待重译/新增/移除、归档旧补丁（审批写操作；重译交 translate_batch）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ToolResult) => [
        { type: 'text', text: `${value.ok ? '增量迁移' : '增量迁移未执行'}\n${value.text}` },
      ],
    },
    async execute(_args, exec) {
      const approve = (plan: MigrationPlan) =>
        requestApproval(
          ctx,
          exec,
          `tav2_migrate：游戏更新后增量迁移。迁移计划：${planSummary(plan)}。`
          + ' 将同步项目 DB（changed/added 标 pending、removed 标 removed、兜底携译文、更新版本指纹）'
          + ' 并把 patch/ 旧补丁产物归档到 patch/archive/，请确认。',
        )
      return runTsMigrate(config, { approve }) as unknown as Tav2ToolResult
    },
  }))
}
