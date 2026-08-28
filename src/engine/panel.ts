/**
 * 翻译工作台查询模块：只读组装当前项目的世界书 / 进度 / 过程快照。
 *
 * 本文件位于 engine 层（不 import dsh 服务），数据全部来自 ProjectDB + 提取的
 * Document，供 /tav2/panel 路由与客户端「翻译」标签页渲染。进度口径与
 * tav2_report 对齐（translated / pending / coveragePct 同源：db.unitStatus）。
 * missing = 非 translated/pending 的单元（引擎现状仅 flagged，即翻译失败待重试；
 * 重跑翻译按 tl 是否有译文选取，会自动重试它们）。
 */
import { ProjectDB } from './db'
import { Document } from './models'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 世界书条目（供面板列表渲染）。 */
export interface PanelWorldbookEntry {
  id: number
  kind: string
  title: string
  status: string
  content: string
  keywords: string[]
  linkedTerm: string
  sourceRefs: string[]
}

/** 单场景进度。 */
export interface PanelProgressScene {
  sceneId: string
  title: string
  units: number
  translated: number
  pending: number
}

/** 翻译进度（口径与 tav2_report 对齐）。 */
export interface PanelProgress {
  scenes: number
  units: number
  translated: number
  pending: number
  /** 非 pending/translated 单元（引擎现状仅 flagged，进人审队列）。 */
  missing: number
  coveragePct: number
  byScene: PanelProgressScene[]
}

/** 最近运行记录（runs 表）。 */
export interface PanelRun {
  runId: string
  kind: string
  status: string
  summary: string
  startedAt: string
  finishedAt: string
}

/** 用量聚合（usage 表）。 */
export interface PanelUsage {
  runs: number
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  elapsedSeconds: number
}

export type PanelFlagType = 'flagged-unit' | 'pending-approval' | 'low-confidence-term'

/** 需人工关注的条目（人审队列 / 待审校 / 低置信术语）。 */
export interface PanelFlag {
  type: PanelFlagType
  label: string
  count: number
}

/** 待审批推敲项（approval_queue，供面板「批准/拒绝/改译名」按钮）。 */
export interface PanelDeliberationItem {
  id: number
  kind: string
  source: string
  target: string
  confidence: string
  rationale: string
}

/** 单场景单元明细（进度明细点开后经 /tav2/panel/scene-units 懒加载）。 */
export interface PanelSceneUnit {
  unitId: string
  /** dialogue | narration | choice | string */
  kind: string
  /** 规范化角色 id（空=旁白/无） */
  speaker: string
  source: string
  /** 当前译文（取 TM 最新一条；无则空串） */
  translation: string
  /** units.status：pending / translated / flagged / removed… */
  status: string
}

/** 翻译失败单元（approval_queue kind=translation_failed，供面板「翻译失败」明细与重试引导）。 */
export interface PanelFailedUnit {
  approvalId: number
  unitId: string
  sceneId: string
  sceneTitle: string
  source: string
  reason: string
}

/** 单次 LLM 请求快照（system + messages + response + usage）。 */
export interface PanelPromptSnapshot {
  seq: number
  stage?: string
  sceneId?: string
  system?: string
  messages: Array<{ role: string; content: string }>
  responseText: string
  elapsedMs: number
  error?: string
  /** 本次调用 token 用量（recorder 已落盘；供实时活动区展示节奏）。 */
  promptTokens: number
  completionTokens: number
}

/** /tav2/panel 返回的完整快照（含按 runId 分组的 prompt 快照目录）。 */
export interface PanelSnapshot {
  worldbook: PanelWorldbookEntry[]
  worldbookPending: number
  progress: PanelProgress
  runs: PanelRun[]
  usage: PanelUsage
  flags: PanelFlag[]
  deliberation: PanelDeliberationItem[]
  /** 翻译失败单元明细（重跑翻译会自动重试它们，面板逐条列出供确认）。 */
  failedUnits: PanelFailedUnit[]
  /** runId → 快照目录名（display；需 recording 已落盘）。 */
  runPromptDirs: Record<string, string>
}

/**
 * 解析「每次运行（runId）一份快照」的关联。
 * 兼容 requests-<runId>.jsonl（每 run 一份）或 requests.jsonl（多个 call 共用）。
 */
export function readRunPromptDirs(snapshotDir: string, runs: Array<Record<string, unknown>>): Record<string, string> {
  if (!snapshotDir || !existsSync(snapshotDir)) return {}
  const runIds = runs.map((r) => String(r.run_id ?? '')).filter(Boolean)
  if (runIds.length === 0) return {}
  const files = readdirSync(snapshotDir).filter((f) => f.toLowerCase().endsWith('.jsonl'))
  const mapping: Record<string, string> = {}
  for (const runId of runIds) {
    const direct = `requests-${runId}.jsonl`
    if (files.includes(direct)) {
      mapping[runId] = direct
      continue
    }
    if (files.includes('requests.jsonl')) {
      mapping[runId] = 'requests.jsonl'
    }
  }
  return mapping
}

/** 单行快照 JSON → 结构化记录（坏行由调用方忽略）。 */
function parsePromptLine(r: Record<string, unknown>, idx: number): PanelPromptSnapshot {
  const usage = (r.usage ?? {}) as Record<string, unknown>
  return {
    seq: Number(r.seq ?? idx + 1),
    stage: typeof r.stage === 'string' ? r.stage : undefined,
    sceneId: typeof r.sceneId === 'string' ? r.sceneId : undefined,
    system: typeof r.system === 'string' ? r.system : undefined,
    messages: Array.isArray(r.messages) ? (r.messages as Array<{ role: string; content: string }>) : [],
    responseText: typeof r.response_text === 'string' ? String(r.response_text) : '',
    elapsedMs: Number(r.elapsed_ms ?? 0),
    error: typeof r.error === 'string' ? String(r.error) : undefined,
    promptTokens: Number(usage.promptTokens ?? 0) || 0,
    completionTokens: Number(usage.completionTokens ?? 0) || 0,
  }
}

/**
 * 解析快照文件（.jsonl）得到完整 prompt 记录（最多前 50 条，坏行忽略）。
 * 供事后查看整段调用；实时活动流用 readRunPromptTail（取最后 N 条）。
 */
export function readRunPrompts(snapshotDir: string, fileName: string): PanelPromptSnapshot[] {
  if (!snapshotDir) return []
  const file = join(snapshotDir, fileName)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const limit = Math.min(raw.length, 50)
  const out: Array<Record<string, unknown> & { isText?: unknown }> = []
  for (let i = 0; i < limit; i += 1) {
    try {
      out.push(JSON.parse(raw[i]!) as Record<string, unknown>)
    } catch {
      // 忽略坏行
    }
  }
  return out.map(parsePromptLine)
}

/**
 * 解析快照文件最后 count 条（jsonl 追加写 → 尾部即最近调用）。
 * 供面板「翻译过程」实时活动区轮询；seq 保持文件内绝对序号。
 */
export function readRunPromptTail(snapshotDir: string, fileName: string, count = 30): PanelPromptSnapshot[] {
  if (!snapshotDir || count <= 0) return []
  const file = join(snapshotDir, fileName)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const start = Math.max(0, raw.length - count)
  const out: PanelPromptSnapshot[] = []
  for (let i = start; i < raw.length; i += 1) {
    try {
      out.push(parsePromptLine(JSON.parse(raw[i]!) as Record<string, unknown>, i))
    } catch {
      // 忽略坏行
    }
  }
  return out
}

/**
 * 组装面板快照（只读，不写任何数据）。
 * snapshotDir 为 recording 落盘根（cfg.debug.requestSnapshotDir）。
 */
export function panelSnapshot(db: ProjectDB, document: Document, snapshotDir?: string): PanelSnapshot {
  const worldbook: PanelWorldbookEntry[] = db.listWorldbook().map((r) => ({
    id: Number(r.id),
    kind: String(r.kind ?? ''),
    title: String(r.title ?? ''),
    status: String(r.status ?? ''),
    content: String(r.content ?? ''),
    keywords: Array.isArray(r.keywords) ? (r.keywords as string[]) : [],
    linkedTerm: String(r.linked_term ?? ''),
    sourceRefs: Array.isArray(r.source_refs) ? (r.source_refs as string[]) : [],
  }))
  const worldbookPending = worldbook.filter((e) => e.status === 'proposed').length

  const byScene: PanelProgressScene[] = document.scenes.map((scene) => {
    let translated = 0
    let pending = 0
    for (const unit of scene.units) {
      const status = db.unitStatus(unit.unit_id)
      if (status === 'translated') translated += 1
      else if (status === 'pending') pending += 1
    }
    return {
      sceneId: scene.scene_id,
      title: scene.title,
      units: scene.units.length,
      translated,
      pending,
    }
  })
  const units = document.allUnits().length
  const translated = byScene.reduce((sum, s) => sum + s.translated, 0)
  const pendingCount = byScene.reduce((sum, s) => sum + s.pending, 0)
  const progress: PanelProgress = {
    scenes: document.scenes.length,
    units,
    translated,
    pending: pendingCount,
    missing: units - translated - pendingCount,
    coveragePct: units > 0 ? Math.round((translated / units) * 100) : 0,
    byScene,
  }

  const runs: PanelRun[] = db.recentRuns(5).map((r) => ({
    runId: String(r.run_id ?? ''),
    kind: String(r.kind ?? ''),
    status: String(r.status ?? ''),
    summary: String(r.summary ?? ''),
    startedAt: String(r.started_at ?? ''),
    finishedAt: String(r.finished_at ?? ''),
  }))
  const totals = db.usageTotals()
  const usage: PanelUsage = {
    runs: totals.runs,
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    elapsedSeconds: totals.elapsedSeconds,
  }

  const flags: PanelFlag[] = []
  if (progress.missing > 0) {
    flags.push({ type: 'flagged-unit', label: '翻译失败待重试（flagged 单元）', count: progress.missing })
  }
  // 「待审校/待决提案」排除 translation_failed：那是「翻译失败待重试」，不是待审校提案，
  // 混算会让两个 flag 对同一批单元重复计数。
  const pendingApprovals = db.pendingApprovals()
    .filter((a) => String(a.kind ?? '') !== 'translation_failed').length
  if (pendingApprovals > 0) {
    flags.push({ type: 'pending-approval', label: '待审校/待决提案', count: pendingApprovals })
  }
  const lowConfidence = db.pendingTerms().filter((t) => String(t.confidence ?? '') === 'low').length
  if (lowConfidence > 0) {
    flags.push({ type: 'low-confidence-term', label: '低置信术语', count: lowConfidence })
  }

  // 「推敲审批」只列真正的改译名提案：payload 带 target。
  // approval_queue 里混有 flagged 单元（translation_failed，仅 source+reason）与
  // 理解阶段的滚动标记（name/term/style，仅 source+hint）——它们没有 target，
  // 不属于推敲定论，不应以「源 → 空目标」的形式出现在本区（走翻译失败通道）。
  const deliberation: PanelDeliberationItem[] = db.pendingApprovals()
    .filter((a) => {
      const p = (a.payload ?? {}) as Record<string, unknown>
      return typeof p.target === 'string' && p.target.trim() !== ''
    })
    .map((a) => {
      const p = (a.payload ?? {}) as Record<string, unknown>
      return {
        id: Number(a.id),
        kind: String(a.kind ?? ''),
        source: String(p.source ?? ''),
        target: String(p.target ?? ''),
        confidence: String(p.confidence ?? ''),
        rationale: String(p.rationale ?? ''),
      }
    })

  const runPromptDirs = snapshotDir ? readRunPromptDirs(snapshotDir, db.recentRuns(20)) : {}

  // 翻译失败明细：approval_queue 的 translation_failed（payload.source 即 unit_id），
  // 关联场景标题供展示。重跑翻译（选取按 tl 是否有译文）会自动重试这些单元。
  const sceneTitleOf = new Map(document.scenes.map((s) => [s.scene_id, s.title] as const))
  const failedUnits: PanelFailedUnit[] = db.pendingApprovals()
    .filter((a) => String(a.kind ?? '') === 'translation_failed')
    .map((a) => {
      const p = (a.payload ?? {}) as Record<string, unknown>
      const unitId = String(p.source ?? '')
      const sceneId = String(p.scene_id ?? '')
      return {
        approvalId: Number(a.id),
        unitId,
        sceneId,
        sceneTitle: sceneTitleOf.get(sceneId) ?? sceneId,
        source: String(p.text ?? ''),
        reason: String(p.reason ?? ''),
      }
    })

  return { worldbook, worldbookPending, progress, runs, usage, flags, deliberation, failedUnits, runPromptDirs }
}

/**
 * 指定场景的单元明细（进度明细点开后懒加载；只读）。
 * 场景成员与顺序以 Document 为准（与 panelSnapshot 进度口径同源），
 * 状态/译文以 ProjectDB 为准（unitStatus / unitTranslation 逐条取，口径一致）。
 * 场景不存在返回 null（路由层转 no-scene）。
 */
export function sceneUnitList(
  db: ProjectDB,
  document: Document,
  sceneId: string,
): { title: string; units: PanelSceneUnit[] } | null {
  const scene = document.scenes.find((s) => s.scene_id === sceneId)
  if (!scene) return null
  const units: PanelSceneUnit[] = scene.units.map((u) => ({
    unitId: u.unit_id,
    kind: u.kind,
    speaker: u.speaker,
    source: u.source,
    translation: db.unitTranslation(u.unit_id),
    status: db.unitStatus(u.unit_id),
  }))
  return { title: scene.title, units }
}
