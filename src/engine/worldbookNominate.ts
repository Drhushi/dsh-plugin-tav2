/**
 * 世界书提名制（nomination）：
 * - 世界书的单位是「设定级实体」，不是词——判定三问见 prompts.ts 的 WORLDBOOK_THREE_QUESTIONS；
 * - 管线只负责聚合证据（出现分布/跨度/样例）与 LLM 推荐，不自动出卡；用户 accept 后才生成卡片草案；
 * - 两条候选通道：scan（词表：人名代码/白名单候选）与 understanding（从场景理解记录沉淀规则/关系类设定）。
 */
import type { EngineConfig } from './config'
import type { Generate } from './llm'
import { extractJsonArray } from './llm'
import { worldbookNominatePrompt, worldbookSedimentPrompt } from './prompts'
import type { ScanCandidate } from './scanning'
import { findOccurrences } from './scanning'

/** 一条世界书提名：尚未出卡，只有证据与推荐意见。 */
export interface Nominee {
  /** 词面或实体稳定名。 */
  source: string
  /** scan=词表通道；understanding=理解沉淀通道。 */
  origin: 'scan' | 'understanding'
  kind: string
  frequency: number
  /** 时序跨度：出现范围覆盖全书行数的比例（0-1），集中爆发的实体接近 0。 */
  spread: number
  /** 出现过的不同文件数（证据展示用）。 */
  files: number
  /** 证据标记 [文件:行号]。 */
  evidence: string[]
  /** understanding 通道：支撑提名的场景 id。 */
  scenes: string[]
  /** understanding 通道：实体核心设定一句话（出卡背景线索）。 */
  hint: string
  /** LLM 三问推荐意见（空串=未推荐/推荐服务不可用）。 */
  reason: string
  recommended: boolean
}

/** 提名键规范化：小写折叠（desire/Desire 合一）+ 去尾部断词连字符。 */
export function nomineeKey(source: string): string {
  return source.trim().replace(/['-]+$/, '').toLowerCase()
}

/** 行号 → 文件名（scan_lines 的 [文件:行号] 前缀）。 */
function fileOfLine(line: string): string {
  const m = /^\[([^:\]]+):/.exec(line.trim())
  return m ? m[1]! : ''
}

/** 从全书出现位置计算时序跨度与证据标记。 */
export function spreadEvidence(
  positions: number[],
  lines: string[],
  maxEvidence = 6,
): { spread: number; files: number; evidence: string[] } {
  const uniq = [...new Set(positions)].sort((a, b) => a - b)
  if (uniq.length === 0 || lines.length === 0) return { spread: 0, files: 0, evidence: [] }
  const first = uniq[0]!
  const last = uniq[uniq.length - 1]!
  const spread = Math.round((last - first + 1) / lines.length * 1000) / 1000
  const files = new Set<string>()
  const evidence: string[] = []
  for (const pos of uniq) {
    const line = lines[pos] ?? ''
    const file = fileOfLine(line)
    if (file) files.add(file)
    const m = /^\[[^\]]+\]/.exec(line.trim())
    if (m && evidence.length < maxEvidence && !evidence.includes(m[0])) evidence.push(m[0])
  }
  return { spread, files: files.size || 1, evidence }
}

export interface BuildScanNomineesOptions {
  /** Ren'Py 人名代码显示名（kind=name）。 */
  characters: Map<string, string>
  /** 词表候选（已进入世界书流程的术语 + 专名白名单）。 */
  candidates: ScanCandidate[]
  lines: string[]
  cfg: EngineConfig
  /** 显式跳过集：术语 skip 终态 / 已 dismiss 的提名，不再提名。 */
  skipKeys: Set<string>
}

/**
 * 词表通道：候选 → 小写折叠合并证据 → 硬淘汰（跨度不足/跳过集）→ 提名。
 * 人物与普通候选同一套跨度标准（低频龙套/一次性角色同样不该出卡）。
 */
export function buildScanNominees(opts: BuildScanNomineesOptions): Nominee[] {
  const minSpread = Math.min(1, Math.max(0, opts.cfg.worldbook.minSpread))

  // 先折叠：同 key（小写+去尾连字符）的候选共享合并后的出现位置（desire/Desire 合一）。
  interface Folded {
    source: string
    kind: string
    positions: number[]
  }
  const folded = new Map<string, Folded>()
  const skip = (source: string): boolean => opts.skipKeys.has(nomineeKey(source))
  const push = (source: string, kind: string, positions: number[]): void => {
    const name = source.trim()
    if (!name) return
    const key = nomineeKey(name)
    if (!key || skip(name)) return
    const existing = folded.get(key)
    if (existing) {
      existing.positions.push(...positions)
      // 保留信息量更大的形态：人名代码 > 全大写 > 原样。
      if (kind === 'name' && existing.kind !== 'name') existing.kind = kind
      return
    }
    folded.set(key, { source: name, kind, positions: [...positions] })
  }

  for (const displayName of opts.characters.values()) {
    push(displayName, 'name', findOccurrences(opts.lines, displayName.trim()))
  }
  for (const cand of opts.candidates) {
    const positions = cand.positions.length > 0
      ? cand.positions
      : findOccurrences(opts.lines, cand.source)
    push(cand.source, cand.kind === 'allcaps' ? 'term' : 'name', positions)
  }

  const raw: Nominee[] = []
  for (const f of folded.values()) {
    const positions = [...new Set(f.positions)].sort((a, b) => a - b)
    const { spread, files, evidence } = spreadEvidence(positions, opts.lines)
    // 硬淘汰：跨度不足（个别场景集中出现/一次性提及）→ 连提名都不进。
    // 满足跨度只代表「值得人看一眼」，是否出卡由三问推荐 + 用户 accept 决定。
    if (spread < minSpread) continue
    raw.push({
      source: f.source,
      origin: 'scan',
      kind: f.kind,
      frequency: positions.length,
      spread,
      files,
      evidence,
      scenes: [],
      hint: '',
      reason: '',
      recommended: false,
    })
  }

  raw.sort((a, b) => b.frequency - a.frequency || a.source.localeCompare(b.source))
  return raw
}

/** 场景理解记录 → 紧凑摘录行（sediment 批次输入）。 */
export function sceneBriefs(records: Array<Record<string, unknown>>): string[] {
  const briefs: string[] = []
  for (const row of records) {
    const sceneId = String(row.scene_id ?? '')
    const rec = (row.record ?? {}) as Record<string, unknown>
    const state = (rec.scene_state ?? {}) as Record<string, unknown>
    const parts: string[] = [`【${sceneId}】`]
    const place = String(state.place ?? '').trim()
    const present = Array.isArray(state.present) ? state.present.map(String).filter(Boolean) : []
    const event = String(state.event ?? '').trim()
    if (place) parts.push(`地点:${place}`)
    if (present.length > 0) parts.push(`在场:${present.join('、')}`)
    if (event) parts.push(`事件:${event}`)
    const threads = Array.isArray(rec.threads) ? rec.threads as Array<Record<string, unknown>> : []
    for (const t of threads) {
      if (String(t.kind ?? '') !== 'long') continue
      const text = String(t.text ?? '').trim()
      if (text) parts.push(`长期伏笔:${text}`)
    }
    if (parts.length > 1) briefs.push(parts.join(' '))
  }
  return briefs
}

export interface SedimentResult {
  nominees: Nominee[]
  errors: string[]
}

/**
 * 理解沉淀通道：把全部场景理解摘录分批交给 LLM 提取设定级实体（提取+三问一步完成）。
 * LLM 不可用时返回空提名 + 错误信息，不影响 scan 通道。
 */
export async function sedimentNominees(
  generate: Generate,
  cfg: EngineConfig,
  understandingRows: Array<Record<string, unknown>>,
): Promise<SedimentResult> {
  const briefs = sceneBriefs(understandingRows)
  const errors: string[] = []
  if (briefs.length === 0) return { nominees: [], errors }
  const batch = Math.max(10, cfg.worldbook.sedimentBatchScenes)
  const nominees: Nominee[] = []
  const seen = new Set<string>()
  for (let i = 0; i < briefs.length; i += batch) {
    const slice = briefs.slice(i, i + batch)
    try {
      const result = await generate.generate({
        system: worldbookSedimentPrompt(),
        messages: [{ role: 'user', content: `场景理解摘录：\n\n${slice.join('\n')}` }],
        reasoningEffort: cfg.worldbook.reasoningEffort || undefined,
      })
      for (const item of extractJsonArray(result.text)) {
        const source = String(item.source ?? '').trim()
        if (!source) continue
        const key = nomineeKey(source)
        if (seen.has(key)) continue
        seen.add(key)
        nominees.push({
          source,
          origin: 'understanding',
          kind: ['name', 'setting', 'lore'].includes(String(item.kind)) ? String(item.kind) : 'lore',
          frequency: 0,
          spread: 1,
          files: 0,
          evidence: [],
          scenes: Array.isArray(item.scenes) ? item.scenes.map((s: unknown) => String(s)).slice(0, 5) : [],
          hint: String(item.hint ?? '').trim(),
          reason: '（理解沉淀通道：提取时已按三问自查）',
          recommended: true,
        })
      }
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err))
    }
  }
  return { nominees, errors }
}

export interface RecommendResult {
  nominees: Nominee[]
  errors: string[]
}

/** 词表通道的三问推荐：批量给判定与理由；LLM 失败时保留全部提名（recommended=false）供人工判断。 */
export async function recommendScanNominees(
  generate: Generate,
  cfg: EngineConfig,
  nominees: Nominee[],
): Promise<RecommendResult> {
  const errors: string[] = []
  if (nominees.length === 0) return { nominees, errors }
  const batch = Math.max(10, cfg.worldbook.batchTerms * 3)
  for (let i = 0; i < nominees.length; i += batch) {
    const slice = nominees.slice(i, i + batch)
    const blocks = slice.map((n) =>
      `【${n.source}】出现 ${n.frequency} 次，跨 ${n.files} 个文件，时序跨度 ${n.spread}；`
      + `证据：${n.evidence.slice(0, 4).join(' ') || '（无标记）'}`)
    try {
      const result = await generate.generate({
        system: worldbookNominatePrompt(),
        messages: [{ role: 'user', content: `候选名单与证据：\n\n${blocks.join('\n')}` }],
        reasoningEffort: cfg.worldbook.reasoningEffort || undefined,
      })
      const bySource = new Map<string, Record<string, unknown>>()
      for (const item of extractJsonArray(result.text)) {
        const source = String(item.source ?? '').trim()
        if (source) bySource.set(nomineeKey(source), item)
      }
      if (bySource.size === 0) {
        // 提名评审要求每个候选出现一次；响应解析为空说明 LLM 输出异常，显形不吞错。
        errors.push('提名评审响应未包含任何有效判定（响应非 JSON 或为空）')
        for (const n of slice) n.reason = '（推荐服务异常，请人工按三问判断）'
        continue
      }
      for (const n of slice) {
        const item = bySource.get(nomineeKey(n.source))
        if (!item) continue
        n.recommended = item.recommended === true
        n.reason = String(item.reason ?? '').trim()
        const kind = String(item.kind ?? '')
        if (['name', 'term', 'setting', 'lore'].includes(kind)) n.kind = kind
      }
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err))
      for (const n of slice) n.reason = '（推荐服务不可用，请人工按三问判断）'
    }
  }
  return { nominees, errors }
}
