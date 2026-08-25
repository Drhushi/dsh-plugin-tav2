/**
 * 术语驱动世界书（按名字做资料卡）：
 * 种子组装（人名代码 → 锁定术语 → 快扫候选）、上下文窗口采样、
 * 分批 LLM 逐名字出卡/判 noinfo、失败可见性。
 * 与 worldbook.ts 的分块生成并存：python 后端仍走分块，TS 主路径走这里。
 */
import type { EngineConfig } from './config'
import type { Generate } from './llm'
import { extractJsonArray } from './llm'
import { worldbookTermsPrompt } from './prompts'
import { findOccurrences, type ScanCandidate } from './scanning'
import { cleanEntry, dedupeEntries, type LoreEntry } from './worldbook'

/** 术语级世界书状态（terms.worldbook_status 的取值语义）。 */
export type WorldbookTermStatus = '' | 'proposed' | 'covered' | 'noinfo' | 'error' | 'skip'

/** 术语驱动种子：一个需要做资料卡的名字。 */
export interface WorldbookSeed {
  source: string
  kind: 'character' | 'name' | 'term' | 'allcaps'
  frequency: number
  positions: number[]
  lockedTarget: string
  /** 0=人名代码 1=锁定术语 2=快扫候选 */
  priority: number
}

/** 单个种子的处理结果。 */
export interface TermOutcome {
  source: string
  status: 'proposed' | 'noinfo' | 'error'
  error?: string
}

export interface BuildSeedsOptions {
  characters: Map<string, string>
  candidates: ScanCandidate[]
  lockedTerms: Array<{ source: string; target: string }>
  lines: string[]
}

/** 组装术语驱动种子：人名代码 → 锁定术语 → 快扫候选，按优先级/频率排序。 */
export function buildWorldbookSeeds(opts: BuildSeedsOptions): WorldbookSeed[] {
  const locked = new Map<string, string>()
  for (const t of opts.lockedTerms) locked.set(t.source, t.target)
  const candidateBySource = new Map(opts.candidates.map((c) => [c.source, c]))
  const seen = new Set<string>()
  const seeds: WorldbookSeed[] = []

  for (const displayName of opts.characters.values()) {
    const source = displayName.trim()
    if (!source || seen.has(source)) continue
    seen.add(source)
    const positions = findOccurrences(opts.lines, source)
    seeds.push({
      source,
      kind: 'character',
      frequency: positions.length,
      positions,
      lockedTarget: locked.get(source) ?? '',
      priority: 0,
    })
  }

  for (const t of opts.lockedTerms) {
    const source = t.source.trim()
    if (!source || seen.has(source)) continue
    seen.add(source)
    const cand = candidateBySource.get(source)
    const positions = cand && cand.positions.length > 0
      ? cand.positions
      : findOccurrences(opts.lines, source)
    seeds.push({
      source,
      kind: cand ? cand.kind : 'term',
      frequency: positions.length,
      positions,
      lockedTarget: t.target,
      priority: 1,
    })
  }

  for (const c of opts.candidates) {
    if (seen.has(c.source)) continue
    seen.add(c.source)
    seeds.push({
      source: c.source,
      kind: c.kind,
      frequency: c.frequency,
      positions: c.positions,
      lockedTarget: locked.get(c.source) ?? '',
      priority: 2,
    })
  }

  seeds.sort(
    (a, b) => a.priority - b.priority || b.frequency - a.frequency || a.source.localeCompare(b.source),
  )
  return seeds
}

/** 从排序去重后的出现位置选 K 个窗口下标：首现 + 均匀中间 + 末现。 */
export function sampleWindowIndexes(positions: number[], k: number): number[] {
  const uniq = [...new Set(positions)].sort((a, b) => a - b)
  if (uniq.length === 0) return []
  const count = Math.max(1, Math.floor(k))
  if (uniq.length <= count) return uniq.map((_, i) => i)
  const idxs: number[] = [0]
  for (let i = 1; i < count - 1; i += 1) {
    idxs.push(Math.round((uniq.length - 1) * i / (count - 1)))
  }
  idxs.push(uniq.length - 1)
  return [...new Set(idxs)]
}

/** 按窗口采样取出上下文片段（含 [文件:行号] 前缀），去重相同窗口。 */
export function sampleWindows(
  lines: string[],
  positions: number[],
  radius: number,
  k: number,
): Array<{ ref: string; text: string }> {
  const uniq = [...new Set(positions)].sort((a, b) => a - b)
  const idxs = sampleWindowIndexes(uniq, k)
  const out: Array<{ ref: string; text: string }> = []
  const seen = new Set<string>()
  for (const idx of idxs) {
    const pos = uniq[idx]!
    const start = Math.max(0, pos - radius)
    const end = Math.min(lines.length, pos + radius + 1)
    const window = lines.slice(start, end)
    const text = window.join('\n')
    if (seen.has(text)) continue
    seen.add(text)
    const locMatch = /^\[([^:\]]+):(\d+)\]/.exec(window[0]?.trim() ?? '')
    out.push({ ref: locMatch ? `[${locMatch[1]}:${locMatch[2]}]` : '', text })
  }
  return out
}

export interface GenerateByTermsOptions {
  generate: Generate
  cfg: EngineConfig
  lines: string[]
  seeds: WorldbookSeed[]
  onProgress?: (done: number, total: number) => void
}

export interface WorldbookByTermsResult {
  outcomes: TermOutcome[]
  pending: Array<{ seedSource: string; entry: LoreEntry }>
  entries: LoreEntry[]
  constants: number
  errors: string[]
}

/** 术语驱动生成：分批复用 LLM 逐名字出卡/判 noinfo；单批失败只记该批，不影响其他批。 */
export async function generateWorldbookByTerms(
  opts: GenerateByTermsOptions,
): Promise<WorldbookByTermsResult> {
  const { generate, cfg, lines, seeds } = opts
  const maxChars = cfg.worldbook.maxContentChars
  const radius = Math.max(0, cfg.worldbook.windowRadius)
  const windows = Math.max(1, cfg.worldbook.sampleWindows)
  const batch = Math.max(1, cfg.worldbook.batchTerms)
  const pending: Array<{ seedSource: string; entry: LoreEntry }> = []
  const outcomes: TermOutcome[] = []
  const errors: string[] = []
  let noinfo = 0
  let error = 0

  const batches: WorldbookSeed[][] = []
  for (let i = 0; i < seeds.length; i += batch) batches.push(seeds.slice(i, i + batch))

  for (let b = 0; b < batches.length; b += 1) {
    const group = batches[b]!
    opts.onProgress?.(Math.min((b + 1) * batch, seeds.length), seeds.length)
    // 方案 E：缓存每个种子的采样窗口（全书位置采样），供提示词与 source_refs 补齐复用。
    const contextMap = new Map<string, Array<{ ref: string; text: string }>>()
    for (const s of group) contextMap.set(s.source, sampleWindows(lines, s.positions, radius, windows))
    const contextBlocks = group
      .map((s) => {
        const ctx = contextMap.get(s.source) ?? []
        const head = `【名字: ${s.source}】` + (s.lockedTarget ? `（锁定译名: ${s.lockedTarget}）` : '')
        const body = ctx.length > 0
          ? ctx.map((w) => w.text).join('\n')
          : '（原文中未找到该名字，无上下文）'
        return `${head}\n${body}`
      })
      .join('\n\n')
    const lockedList = group.filter((s) => s.lockedTarget)
      .map((s) => `${s.source} → ${s.lockedTarget}`)
    const constraint = lockedList.length > 0
      ? `以下译名已锁定，涉及这些名字时必须采用、不得另译：\n  ${lockedList.join('\n  ')}\n\n`
      : ''
    const system = worldbookTermsPrompt(maxChars)
    const user = `${constraint}需要处理的名单与上下文：\n\n${contextBlocks}`

    let items: Array<Record<string, unknown>> = []
    let batchError = ''
    try {
      const result = await generate.generate({
        system,
        messages: [{ role: 'user', content: user }],
        reasoningEffort: cfg.worldbook.reasoningEffort || undefined,
      })
      items = extractJsonArray(result.text)
    } catch (err) {
      batchError = String(err instanceof Error ? err.message : err)
    }

    const bySource = new Map<string, Record<string, unknown>>()
    for (const item of items) {
      const source = String(item.source ?? '').trim()
      if (source) bySource.set(source, item)
    }

    for (const seed of group) {
      if (batchError) {
        outcomes.push({ source: seed.source, status: 'error', error: batchError })
        error += 1
        if (!errors.includes(batchError)) errors.push(batchError)
        continue
      }
      const raw = bySource.get(seed.source)
      if (!raw || raw.noinfo === true) {
        outcomes.push({ source: seed.source, status: 'noinfo' })
        noinfo += 1
        continue
      }
      const entry = cleanEntry(loreEntryFromDict(raw), maxChars)
      if (seed.lockedTarget) entry.title = seed.lockedTarget
      if (!entry.title || (entry.content.length === 0 && entry.keywords.length === 0)) {
        outcomes.push({ source: seed.source, status: 'noinfo' })
        noinfo += 1
        continue
      }
      // 方案 E：综合卡 source_refs 多窗口——LLM 给的来源不足时，用采样窗口的来源补齐
      // （按去掉 [ ] 的文件:行号归一去重，保证至少覆盖多个不同窗口）。
      const refs: string[] = []
      const seenRefs = new Set<string>()
      for (const ref of [...entry.source_refs, ...(contextMap.get(seed.source) ?? []).map((w) => w.ref)]) {
        const norm = String(ref).trim().replace(/^\[|\]$/g, '')
        if (!norm || seenRefs.has(norm)) continue
        seenRefs.add(norm)
        refs.push(ref)
      }
      entry.source_refs = refs.slice(0, 3)
      pending.push({ seedSource: seed.source, entry })
      outcomes.push({ source: seed.source, status: 'proposed' })
    }
  }

  // 去重（不含常驻提升），再按种子出现频率提升常驻（原来“先到先得”改为“频率最高优先”）。
  const entries = dedupeEntries(pending.map((p) => p.entry), { maxConstants: 0 })
  const sourceByTitle = new Map(pending.map((p) => [p.entry.title, p.seedSource]))
  const withSource = entries.map((entry) => ({ entry, source: sourceByTitle.get(entry.title) ?? '' }))
  const maxConstants = Math.max(0, Math.floor(cfg.worldbook.maxConstants || 0))
  const freq = new Map(seeds.map((s) => [s.source, s.frequency]))
  const rankable = withSource
    .filter((x) => (x.entry.kind === 'name' || x.entry.kind === 'setting' || x.entry.kind === 'lore') && x.source)
    .sort((a, b) => (freq.get(b.source) ?? 0) - (freq.get(a.source) ?? 0))
  const promotedTitles = new Set(rankable.slice(0, maxConstants).map((x) => x.entry.title))
  let constants = 0
  for (const x of withSource) {
    if (promotedTitles.has(x.entry.title)) {
      x.entry.kind = 'constant'
      constants += 1
    }
  }

  return {
    outcomes,
    pending,
    entries: withSource.map((x) => x.entry),
    constants,
    errors: errors.slice(0, 3),
  }
}

/** 从 LLM 返回的字典构造 LoreEntry（与 worldbook.ts 的 loreEntryFromDict 同口径，避免循环依赖）。 */
function loreEntryFromDict(data: Record<string, unknown>): LoreEntry {
  return {
    kind: String(data.kind ?? 'lore'),
    title: String(data.title ?? ''),
    keywords: Array.isArray(data.keywords) ? data.keywords.map((k) => String(k)) : [],
    content: String(data.content ?? ''),
    source_refs: Array.isArray(data.source_refs) ? data.source_refs.map((r) => String(r)) : [],
  }
}
