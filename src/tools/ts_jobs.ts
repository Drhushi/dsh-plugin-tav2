/**
 * TS 引擎后台任务：engineBackend=ts 时在 ctx.jobs 内直接跑 TS 翻译核心。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobKindMap, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Config } from '../config'
import { ProjectDB } from '../engine/db'
import { resolveTranslationGenerate } from './translationApi'
import { injectDocumentTranslations } from '../engine/adapters/renpy/adapter'
import { backfillReviewCsv, iterAppliedRows, readReviewCsv } from '../engine/review'
import { runTranslate, unitContextFp } from '../engine/translate'
import type { EngineConfig } from '../engine/config'
import type { Document } from '../engine/models'
import { loadKnowledgeInput } from './tsKnowledge'
import {
  aggregateWorkerResults,
  planSubagentBatches,
  runBatchesWithWorkers,
  runTranslationWorker,
} from './ts_subagents'

/**
 * 按引擎把译文写回游戏（翻译后台任务的回写入口）：renpy → tl/<lang> 文件。
 */
export function injectByEngine(
  engineCfg: EngineConfig,
  document: Document,
  translations: Record<string, string>,
): { ok: boolean; applied: number; warnings: string[] } {
  const injected = injectDocumentTranslations(engineCfg.gameDir, document, translations, engineCfg.lang)
  return { ok: injected.ok, applied: injected.applied, warnings: injected.warnings }
}

export interface StartTsTranslateJobOptions {
  label: string
  limit?: number
  review?: boolean
  budget?: number
  /** 显式指定本轮要翻译的场景 id（分批窗口）；缺省用 limit 取前 N 个待译场景。 */
  scenes?: string[]
  /** 本轮翻译风格（方案 A 启动时解析的结果；config 已设时亦可显式带过以便日志可观测）。 */
  styleOverride?: { preset: string; prompt: string }
}

/** 单批 TS 翻译的结果（output 由调用方任务上下文统一累积）。 */
export type SingleTsJobOutcome = { status: 'completed' | 'failed' | 'killed'; detail: string }

/**
 * 执行一次单批 TS 翻译（含回写/审校分支）。
 * 被 startTsTranslateJob 与子代理分批编排共用；output 由调用方统一附加。
 */
export async function runSingleTsJob(
  ctx: Context,
  config: Config,
  options: StartTsTranslateJobOptions,
  log: (line: string) => void,
  signal: AbortSignal,
): Promise<SingleTsJobOutcome> {
  let db: ProjectDB | null = null
  try {
    const input = loadKnowledgeInput(config)
    const engineCfg = input.engineCfg
    if (options.styleOverride && (options.styleOverride.preset || options.styleOverride.prompt)) {
      engineCfg.translation = { ...engineCfg.translation, ...options.styleOverride }
      log(`[tav2-ts] 翻译风格：${options.styleOverride.preset || '(自定义)'}${options.styleOverride.prompt ? `（${options.styleOverride.prompt.slice(0, 40)}）` : ''}`)
    }
    log(`[tav2-ts] 引擎配置：${engineCfg.engine} / ${engineCfg.llm.model}`)
    const document = input.document
    if (options.scenes !== undefined && options.scenes.length > 0) {
      const wanted = new Set(options.scenes)
      document.scenes = document.scenes.filter((s) => wanted.has(s.scene_id))
      log(`[tav2-ts] 分批窗口：指定 ${document.scenes.length} 个场景`)
    } else {
      log(`[tav2-ts] 文档加载完成：${document.scenes.length} 场景`)
    }
    db = new ProjectDB(input.dbPath)
    const generate = await resolveTranslationGenerate(ctx, config, engineCfg, 'main-pipeline')
    const stats = await runTranslate(generate, db, engineCfg, document, {
      limit: options.scenes !== undefined && options.scenes.length > 0 ? undefined : options.limit,
      review: options.review,
      budget: options.budget,
      signal,
      onLog: log,
    })
    log(`[tav2-ts] 翻译完成：${JSON.stringify(stats)}`)
    const tokens = stats.usage.prompt_tokens + stats.usage.completion_tokens
    const detail = [
      `units: ${stats.units_translated}/${stats.units_total}`,
      `scenes: ${stats.scenes_done}/${stats.scenes_total}`,
      `batches: ${stats.sub_batches_done}/${stats.sub_batches_total}`,
      `tokens: ${tokens}`,
      stats.retry_rounds > 0 ? `retries: ${stats.retry_rounds}` : '',
    ].filter(Boolean).join(' ')
    if (options.review) {
      log(`[tav2-ts] 审校模式：不写回 tl，审校表已导出到 ${stats.review_sheet ?? ''}`)
    } else {
      const translations = stats.translations ?? {}
      if (Object.keys(translations).length > 0) {
        const injected = injectByEngine(engineCfg, document, translations)
        if (!injected.ok) {
          throw new Error(`回写失败：${injected.warnings.join('；')}`)
        }
        log(`[tav2-ts] 回写完成：applied=${injected.applied}`)
      } else {
        log('[tav2-ts] 本轮无新译文，跳过回写')
      }
    }
    return { status: 'completed', detail }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err)
    log(`[tav2-ts] 失败：${message}`)
    if (signal.aborted) {
      return { status: 'killed', detail: 'cancelled' }
    }
    return { status: 'failed', detail: message.slice(0, 200) }
  } finally {
    db?.close()
  }
}

/** 启动一个运行 TS 翻译核心的后台任务（单批直跑）。 */
export function startTsTranslateJob(
  ctx: Context,
  config: Config,
  options: StartTsTranslateJobOptions,
  owner?: Agent,
): JobId {
  return ctx.jobs.start({
    kind: 'tav2' as JobKindMap['tav2'],
    label: options.label,
    outputLimitBytes: config.maxOutputChars * 3,
    // owner 必传，见 src/core/tav2.ts startTav2Job 注释。
    owner,
    run() {
      let output = ''
      const controller = new AbortController()
      const log = (line: string) => {
        output += `${line}\n`
      }
      const done = runSingleTsJob(ctx, config, options, log, controller.signal)
        .then((outcome) => ({ ...outcome, output }))
      return {
        cancel: () => controller.abort(),
        done,
        readOutput: () => {
          const text = output
          output = ''
          return text
        },
      }
    },
  })
}

/**
 * 启动 TS 分批翻译后台任务：按 limit/batch 语义把待译场景切成批次，
 * 子代理并行翻译（上限 subagentMaxWorkers）。窗口 <=1、maxWorkers<=1、
 * review/budget 流程或 agents 服务缺失时退化为单批直跑（等价旧行为）。
 */
export function startTsBatchTranslateJob(
  ctx: Context,
  config: Config,
  options: StartTsTranslateJobOptions,
  owner?: Agent,
): JobId {
  return ctx.jobs.start({
    kind: 'tav2' as JobKindMap['tav2'],
    label: options.label,
    outputLimitBytes: config.maxOutputChars * 3,
    owner,
    run() {
      let output = ''
      const controller = new AbortController()
      const log = (line: string) => {
        output += `${line}\n`
      }
      const done = (async (): Promise<JobOutcome> => {
        const maxWorkers = Math.max(1, Math.floor(config.subagentMaxWorkers ?? 2))
        try {
          const input = loadKnowledgeInput(config)
          const engineCfg = input.engineCfg
          log(`[tav2-ts] 引擎配置：${engineCfg.engine} / ${engineCfg.llm.model}`)
          const pendingIds = input.document.scenes
            .filter((s) => s.units.some((u) => !u.extra.translated))
            .map((s) => s.scene_id)
          const wanted = options.scenes !== undefined && options.scenes.length > 0
            ? new Set(options.scenes)
            : undefined
          const baseIds = wanted === undefined ? pendingIds : pendingIds.filter((id) => wanted.has(id))
          const plan = planSubagentBatches(baseIds, options.limit, maxWorkers)
          log(`[tav2-ts] 待译窗口 ${plan.total} 个场景，切为 ${plan.batches.length} 批（并行上限 ${maxWorkers}）`)

          const singleFallback = (scenes: string[] | undefined): Promise<JobOutcome> =>
            runSingleTsJob(ctx, config, { ...options, scenes }, log, controller.signal)
              .then((outcome) => ({ ...outcome, output }))

          // scope=experimental：强制单批直跑（不派生子代理），便于 A/B。
          if (config.translationApi?.scope === 'experimental') {
            log('[tav2-ts] scope=experimental：强制单批直跑（不派生子代理）')
            return singleFallback(wanted === undefined ? options.scenes : baseIds)
          }

          if (plan.batches.length <= 1 || maxWorkers <= 1 || options.review || options.budget != null || !owner) {
            // 单批/人工/预算流程：直跑，保持旧行为。
            return singleFallback(wanted === undefined ? options.scenes : baseIds)
          }

          const results = await runBatchesWithWorkers(plan.batches, maxWorkers, (sceneIds, index) =>
            runTranslationWorker({
              ctx,
              parent: owner,
              config,
              batch: { sceneIds, label: `batch-${index + 1}` },
              signal: controller.signal,
            }))
          for (const result of results) {
            log(`[子代理 ${result.childId}] ${result.ok ? '完成' : '失败'}：${result.output || result.error || ''}`)
          }
          const agg = aggregateWorkerResults(results)
          const detail = [
            `scenes: ${agg.totalScenes}/${plan.total}`,
            `units: ${agg.totalUnits}`,
            `batches: ${agg.done}/${results.length}`,
            `tokens: ${agg.totalTokens}`,
            agg.totalFailed > 0 ? `failed: ${agg.totalFailed}` : '',
          ].filter(Boolean).join(' ')
          if (agg.failedBatches.length > 0) {
            log(`[tav2-ts] ${agg.failedBatches.length} 个子代理批次失败（${agg.failedBatches.join('、')}）`)
            return { status: 'failed', detail: `${detail} failed_batches=${agg.failedBatches.length}`, output }
          }
          return { status: 'completed', detail, output }
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err)
          log(`[tav2-ts] 分批编排失败：${message}`)
          if (controller.signal.aborted) {
            return { status: 'killed', detail: 'cancelled', output }
          }
          return { status: 'failed', detail: message.slice(0, 200), output }
        }
      })()
      return {
        cancel: () => controller.abort(),
        done,
        readOutput: () => {
          const text = output
          output = ''
          return text
        },
      }
    },
  })
}


export interface StartTsReviewBackfillOptions {
  label: string
  reviewFile: string
  /** 忽略审校状态强制回填（人工/机器译文非空即应用）。 */
  force?: boolean
}

/** TS 审校 CSV 回填核心（写 tl + 同步 units/TM）；后台任务与前台降级共用。 */
export async function runTsReviewBackfill(
  ctx: Context,
  config: Config,
  options: StartTsReviewBackfillOptions,
  log: (line: string) => void,
): Promise<JobOutcome> {
  let db: ProjectDB | null = null
  try {
    const input = loadKnowledgeInput(config)
    const rows = readReviewCsv(options.reviewFile)
    db = new ProjectDB(input.dbPath)
    const stats = backfillReviewCsv(input.engineCfg.gameDir, input.engineCfg.lang, rows, options.force)
    const applied = iterAppliedRows(rows, options.force)
    let synced = 0
    let cleared = 0
    const units = input.document.allUnits()
    // 回填即人工定论：同步清掉对应单元的 translation_failed 待审批，避免审校队列卡住。
    const failedApprovals = new Map<string, number>()
    for (const a of db.pendingApprovals()) {
      if (String(a.kind ?? '') !== 'translation_failed') continue
      const p = (a.payload ?? {}) as Record<string, unknown>
      failedApprovals.set(String(p.source ?? ''), Number(a.id))
    }
    for (const row of applied) {
      const unit = matchReviewUnit(row, units)
      if (!unit) continue
      const translation = (row['人工译文'] || row['机器译文'] || '').trim()
      if (!translation) continue
      const scene = input.document.scenes.find((s) => s.units.includes(unit))
      const fp = scene ? unitContextFp(unit, scene) : ''
      db.tmPut(unit.source, unit.unit_id, translation, fp)
      db.setUnitStatus(unit.unit_id, 'translated')
      const approvalId = failedApprovals.get(unit.unit_id)
      if (approvalId && db.decideApproval(approvalId, 'approved')) cleared += 1
      synced += 1
    }
    log(`[tav2-ts] 审校回填完成：${JSON.stringify({ ...stats, db_synced: synced, ...(cleared ? { approvals_cleared: cleared } : {}) })}`)
    // 拒绝静默 no-op：一行都没回填时按失败处理，把原因说明白（曾导致 agent 误以为成功后手工搬运 xlsx）。
    if (stats.applied === 0 && stats.skipped > 0) {
      const detail = Object.entries(stats.skipReasons).map(([k, v]) => `${k}×${v}`).join('；') || '未知原因'
      log(`[tav2-ts] ⚠️ 没有任何行被回填（跳过 ${stats.skipped} 条：${detail}）。回填条件：状态=已确认/已修改 且 译文非空。`)
      return { status: 'failed', detail: `no rows applied; skipped=${stats.skipped}（${detail}）` }
    }
    return {
      status: 'completed',
      detail: `applied=${stats.applied} skipped=${stats.skipped} db_synced=${synced}`,
    }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err)
    log(`[tav2-ts] 审校回填失败：${message}`)
    return { status: 'failed', detail: message.slice(0, 200) }
  } finally {
    db?.close()
  }
}
/** 启动 TS 审校 CSV 回填后台任务：写 tl + 同步 units/TM。 */
export function startTsReviewBackfillJob(
  ctx: Context,
  config: Config,
  options: StartTsReviewBackfillOptions,
  owner?: Agent,
): JobId {
  return ctx.jobs.start({
    kind: 'tav2' as JobKindMap['tav2'],
    label: options.label,
    outputLimitBytes: config.maxOutputChars * 3,
    owner,
    run() {
      let output = ''
      const log = (line: string) => {
        output += `${line}
`
      }
      const done = (async (): Promise<JobOutcome> => {
        const outcome = await runTsReviewBackfill(ctx, config, options, log)
        return { ...outcome, output }
      })()
      return {
        cancel: () => {},
        done,
        readOutput: () => {
          const text = output
          output = ''
          return text
        },
      }
    },
  })
}

function matchReviewUnit(row: Record<string, string>, units: import('../engine/models').Unit[]): import('../engine/models').Unit | undefined {
  const rowType = row['类型'] || ''
  const filename = row['文件'] || ''
  if (rowType === 'dialogue') {
    const identifier = row['标识符'] || ''
    const sayIndex = Number.parseInt(row['序号'] || '0', 10) || 0
    return units.find((u) => u.kind === 'dialogue'
      && u.unit_id === `${identifier}#${sayIndex}`
      && String(u.extra.file ?? '') === filename)
  }
  if (rowType === 'string') {
    const old = row['标识符'] || ''
    return units.find((u) => u.kind === 'string'
      && u.source === old
      && String(u.extra.file ?? '') === filename)
  }
  return undefined
}
