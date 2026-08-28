/**
 * 双阶段翻译执行器（TS 版 TranslateRunner）。
 * 与 Python 行为对齐：场景理解 → 记忆包 → 子批重写 → 门禁 → TM/摘要落库。
 * M3 只落 DB 并返回译文；M5 由调用方回写 tl；review=true 时导出审校 CSV。
 */

import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { EngineConfig } from './config'
import type { ProjectDB } from './db'
import { bannedWordHits, ensureTranslationTag, tagsPreserved, termAudit } from './gates'
import type { Generate } from './llm'
import { extractJson, TrackedGenerate } from './llm'
import { buildMemoryPack } from './memory'
import { Document, Scene, type Unit } from './models'
import { polishPrompt, antiClichePrompt, styleInstruction, summaryPrompt } from './prompts'
import { jsonlRecorder, RecordingGenerate } from './recording'
import { MAX_RETRY_ROUNDS, rewriteScene } from './rewrite'
import { writeReviewCsv } from './review'
import { estimateTokens } from './tokens'
import { generateUnderstanding } from './understanding'

export { estimateTokens } from './tokens'

/** 与 Python split_units 的 _UNIT_OVERHEAD 对齐的批次开销估算。 */
const UNIT_OVERHEAD = 8

/** 把已排序的单元按条数/token 预算切分为子批（保持原始顺序）。 */
export function splitUnits(units: Unit[], maxUnits = 15, maxTokens = 3000): Unit[][] {
  maxUnits = Math.max(Math.floor(maxUnits || 0), 1)
  maxTokens = Math.max(Math.floor(maxTokens || 0), 1)
  const batches: Unit[][] = []
  let current: Unit[] = []
  let tokenSum = 0
  for (const unit of units) {
    const cost = estimateTokens(unit.source) + UNIT_OVERHEAD
    if (current.length && (current.length >= maxUnits || tokenSum + cost > maxTokens)) {
      batches.push(current)
      current = []
      tokenSum = 0
    }
    current.push(unit)
    tokenSum += cost
  }
  if (current.length) batches.push(current)
  return batches
}

/** 把纯字符串场景合并为一个全局字符串场景。 */
export function mergeStringScenes(document: Document): Scene {
  const stringScenes = document.scenes.filter(
    (s) => s.units.length > 0 && s.units.every((u) => u.kind === 'string'),
  )
  if (stringScenes.length <= 1) return stringScenes[0] ?? new Scene('strings', 'strings', 0)
  const first = stringScenes[0]!
  const merged = new Scene('strings', 'strings', document.scenes.indexOf(first))
  const units: Unit[] = []
  for (const scene of stringScenes) units.push(...scene.units)
  units.sort((a, b) =>
    String(a.extra.file ?? '').localeCompare(String(b.extra.file ?? ''))
    || a.source.localeCompare(b.source))
  for (const unit of units) unit.scene_id = 'strings'
  merged.units = units
  document.scenes = [...document.scenes.filter((s) => !stringScenes.includes(s)), merged]
  document.scenes.forEach((s, idx) => {
    s.order = idx
  })
  return merged
}

/** 单元上下文指纹：对话 = md5(file|label|speaker|前2|后2)；字符串 = md5(file)。 */
export function unitContextFp(unit: Unit, scene: Scene): string {
  const file = String(unit.extra.file ?? '')
  if (unit.kind === 'string') return md5(file)
  const label = scene.scene_id.includes('::')
    ? scene.scene_id.split('::', 2)[1]
    : scene.scene_id
  const idx = scene.units.findIndex((u) => u.unit_id === unit.unit_id)
  const prev = scene.units.slice(Math.max(0, idx - 2), idx).map((u) => u.source).join(' | ')
  const next = scene.units.slice(idx + 1, idx + 3).map((u) => u.source).join(' | ')
  return md5(`${file}|${label}|${unit.speaker}|${prev}|${next}`)
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** 扫描文档中可被 TM 直接复用的待译单元（同源+同上下文指纹）。 */
export function matchReusable(document: Document, db: ProjectDB): { translations: Record<string, string>; srcTokens: number } {
  const translations: Record<string, string> = {}
  let srcTokens = 0
  for (const scene of document.scenes) {
    for (const unit of scene.units) {
      if (unit.extra.translated) continue
      const fp = unitContextFp(unit, scene)
      const text = db.tmGet(unit.source, fp)
      if (text && text !== unit.source) {
        translations[unit.unit_id] = text
        srcTokens += estimateTokens(unit.source)
      }
    }
  }
  return { translations, srcTokens }
}

/** 把理解记录中的新词/新角色标记送入审批队列（幂等）。 */
export function queueRollingFlags(db: ProjectDB, flags: Array<Record<string, string>>): number {
  let count = 0
  for (const flag of flags) {
    const kind = String(flag.kind ?? '')
    const source = String(flag.source ?? '').trim()
    if (!['name', 'term', 'style'].includes(kind) || !source) continue
    if (db.pendingApprovalExists(kind, source)) continue
    db.addApproval(kind, { source, hint: String(flag.hint ?? '') })
    count += 1
  }
  return count
}

export function updateSummary(
  generate: Generate,
  cfg: EngineConfig,
  summary: string,
  newText: string,
  signal?: AbortSignal,
): Promise<string> {
  const words = Math.floor(cfg.context.summaryTokens / 2)
  const prompt = summaryPrompt(words, summary || '（暂无）', newText)
  return generate.generate({
    system: '你是视觉小说剧情的摘要助手。',
    messages: [{ role: 'user', content: prompt }],
    meta: { stage: 'summary' },
    signal,
  }).then((r) => r.text.trim())
}

function polishScene(
  generate: Generate,
  cfg: EngineConfig,
  db: ProjectDB,
  scene: Scene,
  translations: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const items: Array<{ key: string; source: string; translated: string }> = []
  for (const unit of scene.units) {
    const translated = translations[unit.unit_id]
    if (translated !== undefined) items.push({ key: unit.unit_id, source: unit.source, translated })
  }
  if (items.length === 0) return Promise.resolve({})
  const characters = db.getCharacters()
  const profiles = [...new Set(scene.units.map((u) => u.speaker).filter(Boolean))]
    .map((speaker) => {
      const ch = characters[speaker]
      return ch ? `${speaker}（${ch.name_zh ?? ''}：${ch.style_notes ?? ''}）` : speaker
    })
    .join('；')
  const summary = db.getSummary(scene.branch)
  const antiCliche = cfg.translation.antiCliche.enabled
    ? antiClichePrompt(cfg.translation.antiCliche.categories)
    : ''
  const prompt = polishPrompt(summary, profiles, styleInstruction(cfg.translation.stylePreset, cfg.translation.stylePrompt, cfg.translation.head), antiCliche)
  const lines = ['待复查项：']
  for (const item of items) {
    lines.push(`标识符: ${item.key}`)
    lines.push(`源: ${item.source}`)
    lines.push(`译: ${item.translated}`)
  }
  return generate.generate({
    system: '你是翻译一致性复查器。',
    messages: [{ role: 'user', content: `${prompt}\n\n${lines.join('\n')}` }],
    meta: { stage: 'polish', sceneId: scene.scene_id },
    signal,
  }).then((r) => {
    try {
      const data = extractJson(r.text)
      const corrections: Record<string, string> = {}
      const srcMap = new Map(items.map((i) => [i.key, i.source]))
      for (const [key, value] of Object.entries(data)) {
        const unitId = key.trim()
        const source = srcMap.get(unitId)
        const text = String(value ?? '').trim()
        if (source !== undefined && text && tagsPreserved(source, text)) {
          corrections[unitId] = ensureTranslationTag(source, text)
        }
      }
      return corrections
    } catch {
      return {}
    }
  })
}

export interface TranslateOptions {
  limit?: number
  dryRun?: boolean
  budget?: number
  review?: boolean
  signal?: AbortSignal
  onLog?: (line: string) => void
}

export interface SubBatchRecord {
  scene_id: string
  sub_index: number
  sub_total: number
  units: number
  source_units: number
  translated: number
  prompt_tokens: number
  completion_tokens: number
  elapsed_s: number
  retries: number
}

export interface TranslateStats {
  run_id: string
  scenes_total: number
  scenes_done: number
  units_total: number
  units_translated: number
  /** 本轮产出的 unit_id -> 译文（供 M5 适配器回写 tl 文件）。 */
  translations: Record<string, string>
  retry_rounds: number
  term_misses: number
  banned_hits: number
  /** P1：反翻译腔禁令族命中数（无原文依据的触发词出现次数）。 */
  anti_cliche_hits: number
  /** P1：autoFix=true 时确定性移除的触发词数。 */
  anti_cliche_fixed: number
  approvals_queued: number
  /** 重试后仍未产出合法译文、已转入人审的单元数。 */
  flagged_units: number
  /** 方案 F：应该生成理解但解析/调用失败（生成 null）的场景数。 */
  understanding_failed: number
  /** 方案 F：生成了理解但字段不完整（completeness 校验不过）的场景数。 */
  understanding_incomplete: number
  branch_tracks: number
  sub_batches_total: number
  sub_batches_done: number
  sub_batch_records: SubBatchRecord[]
  reused_units: number
  review_sheet?: string
  usage: { calls: number; prompt_tokens: number; completion_tokens: number }
  elapsed_seconds: number
  cost_estimate_usd: number
}

function buildTracks(scenes: Scene[]): Scene[][] {
  const tracks: Scene[][] = []
  const order = new Map<string, number>()
  for (const scene of scenes) {
    if (!order.has(scene.branch)) {
      order.set(scene.branch, tracks.length)
      tracks.push([])
    }
    tracks[order.get(scene.branch)!]!.push(scene)
  }
  return tracks
}

/** 并发上限执行器：最多 limit 个任务同时运行。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

function scenePending(scene: Scene): boolean {
  return scene.units.some((u) => !u.extra.translated)
}

/** 执行 TS 双阶段翻译，返回统计（DB 落库，tl 文件回填由 M5 适配器负责）。 */
export async function runTranslate(
  generate: Generate,
  db: ProjectDB,
  cfg: EngineConfig,
  document: Document,
  options: TranslateOptions = {},
): Promise<TranslateStats> {
  const runId = randomUUID()
  const log = options.onLog ?? ((line: string) => console.log(line))
  db.beginRun(runId, 'translate')
  // 请求快照：默认开启录制，写到项目 DB 旁的 requests/（每 run 一个文件，供面板
  // 「翻译过程 → 展开 → system/messages」查看）；显式配置 debug.request_snapshot_dir
  // 时写往该目录（A/B 审计用，兼容旧行为但按 runId 分文件）。
  const configuredSnapshotDir = cfg.debug.requestSnapshotDir.trim()
  const snapshotDir = configuredSnapshotDir || join(dirname(db.path), 'requests')
  const base = new RecordingGenerate(generate, jsonlRecorder(join(snapshotDir, `requests-${runId}.jsonl`)))
  const tracked = new TrackedGenerate(base)
  const stats: TranslateStats = {
    run_id: runId,
    scenes_total: 0,
    scenes_done: 0,
    units_total: 0,
    units_translated: 0,
    translations: {},
    retry_rounds: 0,
    term_misses: 0,
    banned_hits: 0,
    anti_cliche_hits: 0,
    anti_cliche_fixed: 0,
    approvals_queued: 0,
    flagged_units: 0,
    understanding_failed: 0,
    understanding_incomplete: 0,
    branch_tracks: 0,
    sub_batches_total: 0,
    sub_batches_done: 0,
    sub_batch_records: [],
    reused_units: 0,
    usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
    elapsed_seconds: 0,
    cost_estimate_usd: 0,
  }
  try {
    mergeStringScenes(document)
    let scenes = document.scenes.filter(scenePending)
    if (options.limit) scenes = scenes.slice(0, options.limit)
    stats.scenes_total = scenes.length
    stats.units_total = scenes.reduce((n, s) => n + s.units.length, 0)
    const collected: Record<string, string> = {}
    if (!options.dryRun) {
      const reusable = matchReusable(document, db)
      db.syncUnits(document)
      if (Object.keys(reusable.translations).length > 0) {
        stats.reused_units = Object.keys(reusable.translations).length
      }
    }
    const tracks = buildTracks(scenes)
    stats.branch_tracks = tracks.length
    const mainBranch = tracks[0]?.[0]?.branch ?? 'main'

    const runTrack = async (track: Scene[]): Promise<void> => {
      const branch = track[0]?.branch ?? 'main'
      let sceneCounter = 0
      for (const scene of track) {
        if (options.budget && tracked.usage.totalTokens() >= options.budget) {
          log(`[翻译] 已达 token 预算 ${options.budget}，保存进度退出（重跑续传）`)
          break
        }
        log(`[翻译] 场景 ${scene.scene_id} 开始（分支 ${scene.branch}，本轨道第 ${sceneCounter + 1}/${track.length} 个）`)
        const outcome = await processScene(
          tracked, db, cfg, scene, mainBranch, stats, options.dryRun === true, options.review === true, options.signal, log,
        )
        sceneCounter += 1
        stats.scenes_done += 1
        stats.units_translated += Object.keys(outcome.translations).length
        Object.assign(collected, outcome.translations)
        log(`[翻译] 场景 ${scene.scene_id} 完成：译文 ${Object.keys(outcome.translations).length} 行，术语漏翻 ${outcome.termMisses.length}，反翻译腔 ${outcome.banned}`)
        const every = cfg.context.summaryEvery
        if (!options.dryRun && sceneCounter % every === 0) {
          await refreshSummary(tracked, db, cfg, branch, scene, outcome.translations, options.signal)
        }
      }
    }

    // 分支级并行（对齐 Python branch.parallel + context.max_workers）：
    // 互不依赖的分支轨道同时翻译，墙钟时间下降、token 不变；默认串行。
    const parallel = cfg.branch.parallel && tracks.length > 1
    const workers = Math.max(1, Math.floor(cfg.context.maxWorkers || 1))
    if (parallel && workers > 1) {
      await mapLimit(tracks, Math.min(workers, tracks.length), runTrack)
    } else {
      for (const track of tracks) await runTrack(track)
    }

    stats.translations = collected
    if (options.review && !options.dryRun) {
      stats.review_sheet = writeReviewCsv(dirname(db.path), document, collected, cfg.lang)
    }
    const usage = tracked.usage.snapshot()
    db.addUsage(runId, usage.calls, usage.prompt_tokens, usage.completion_tokens, tracked.usage.elapsedSeconds)
    stats.usage = usage
    stats.elapsed_seconds = Math.round(tracked.usage.elapsedSeconds * 100) / 100
    db.finishRun(runId, JSON.stringify(stats))
    return stats
  } catch (err) {
    db.failRun(runId, String(err instanceof Error ? err.message : err))
    throw err
  }
}

async function processScene(
  generate: TrackedGenerate,
  db: ProjectDB,
  cfg: EngineConfig,
  scene: Scene,
  mainBranch: string,
  stats: TranslateStats,
  dryRun: boolean,
  review: boolean,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<{ translations: Record<string, string>; termMisses: Array<Record<string, string>>; banned: number }> {
  const units = scene.units.filter((u) => !u.extra.translated)
  if (units.length === 0) return { translations: {}, termMisses: [], banned: 0 }
  const sources = units.map((u) => u.source)
  const memory = await buildMemoryPack(db, cfg, scene, sources, mainBranch)

  let understanding = null
  // 场景级口吻判断：所有场景（含纯 string 场景，如合并后的全局 strings）都走理解链路，
  // 产出 tone（场景文风指引）供重写把握基调；对话场景产出 scene_state/伏笔/术语/口癖。
  const wantsUnderstanding = true
  if (wantsUnderstanding) {
    understanding = await generateUnderstanding(generate, cfg, scene, memory, signal)
    if (understanding) {
      // 方案 F：理解硬闸门——字段不完整计入统计（不阻断翻译，供验收核对生成率/完整率）。
      const quality = understanding.completeness()
      if (!quality.ok) stats.understanding_incomplete += 1
      db.saveUnderstanding(understanding, scene.branch)
      stats.approvals_queued += queueRollingFlags(db, understanding.flags)
    } else {
      stats.understanding_failed += 1
    }
  }

  // 分批对齐 Python split_units 语义：读 scene_max_units / context.max_tokens，
  // 并以 adaptive_* 为上限。
  const maxUnits = Math.min(cfg.context.sceneMaxUnits, cfg.context.adaptiveMaxUnits)
  const maxTokens = Math.min(cfg.context.maxTokens, cfg.context.adaptiveMaxTokens)
  const subBatches = splitUnits(units, maxUnits, maxTokens)
  stats.sub_batches_total += subBatches.length

  const translations: Record<string, string> = {}
  for (let index = 0; index < subBatches.length; index += 1) {
    const sub = subBatches[index]!
    const started = performance.now()
    const before = generate.usage.snapshot()
    const subTranslations = await rewriteScene(
      generate,
      cfg,
      scene,
      memory,
      understanding,
      sub,
      signal,
      (failure) => {
        stats.retry_rounds += 1
        log(
          `[翻译] ${scene.scene_id} 子批 ${index + 1}/${subBatches.length} `
          + `第 ${failure.round + 1} 轮失败 ${failure.unitIds.length} 条：${failure.reason}`,
        )
      },
      (antiCliche) => {
        stats.anti_cliche_hits += antiCliche.hits.length
        if (cfg.translation.antiCliche.autoFix) stats.anti_cliche_fixed += antiCliche.hits.length
      },
    )
    const after = generate.usage.snapshot()
    Object.assign(translations, subTranslations)
    const record: SubBatchRecord = {
      scene_id: scene.scene_id,
      sub_index: index + 1,
      sub_total: subBatches.length,
      units: sub.length,
      source_units: sub.filter((u) => u.source).length,
      translated: Object.keys(subTranslations).length,
      prompt_tokens: after.prompt_tokens - before.prompt_tokens,
      completion_tokens: after.completion_tokens - before.completion_tokens,
      elapsed_s: Math.round((performance.now() - started) / 100) / 10,
      retries: Math.max(0, after.calls - before.calls - 1),
    }
    stats.sub_batch_records.push(record)
    stats.sub_batches_done += 1
  }

  const sourceMap: Record<string, string> = {}
  for (const unit of units) sourceMap[unit.unit_id] = unit.source
  const failedUnits = units.filter((u) => !(u.unit_id in translations))
  if (failedUnits.length > 0) {
    stats.flagged_units += failedUnits.length
    log(
      `[翻译] 场景 ${scene.scene_id}：${failedUnits.length} 条在 ${MAX_RETRY_ROUNDS + 1} 轮后仍未通过，`
      + '已标记 flagged 并进入人审队列',
    )
    if (!dryRun) {
      for (const unit of failedUnits) {
        if (!db.pendingApprovalExists('translation_failed', unit.unit_id)) {
          db.addApproval('translation_failed', {
            source: unit.unit_id,
            text: unit.source.slice(0, 200),
            scene_id: scene.scene_id,
            reason: '模型重试后未返回译文或未通过标签/完整性校验',
          })
        }
        db.setUnitStatus(unit.unit_id, 'flagged')
      }
    }
  }
  const termMisses = termAudit(translations, sourceMap, db.lockedTerms())
  const banned = Object.values(translations).reduce((n, t) => n + bannedWordHits(t).length, 0)
  stats.term_misses += termMisses.length
  stats.banned_hits += banned

  const every = cfg.context.polishEvery
  if (!dryRun && scene.order && scene.order % every === 0) {
    const corrections = await polishScene(generate, cfg, db, scene, translations, signal)
    Object.assign(translations, corrections)
  }

  for (const unit of units) {
    const translation = translations[unit.unit_id]
    if (translation !== undefined && !dryRun) {
      db.tmPut(unit.source, unit.unit_id, translation, unitContextFp(unit, scene))
      if (!review) db.setUnitStatus(unit.unit_id, 'translated')
    }
  }
  return { translations, termMisses, banned }
}

async function refreshSummary(
  generate: Generate,
  db: ProjectDB,
  cfg: EngineConfig,
  branch: string,
  scene: Scene,
  translations: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const sources = scene.units.map((u) => u.source).join('\n')
  const translated = Object.values(translations).join('\n')
  const newText = `${sources}\n\n译文：\n${translated}`
  const old = db.getSummary(branch)
  const updated = await updateSummary(generate, cfg, old, newText, signal)
  if (updated) db.saveSummary(branch, updated, scene.order)
}
