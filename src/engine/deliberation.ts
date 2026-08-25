/**
 * 译前推敲（与 Python tav2/deliberation.py 对齐）：
 * 多方位评估候选术语，查证为证据，高置信自动采纳，其余进审批队列。
 * 查证通过 EvidenceProvider 注入；引擎默认无查证（dsh 侧接 tool-web）。
 */

import type { EngineConfig } from './config'
import type { ProjectDB } from './db'
import type { Generate } from './llm'
import { extractJson, extractJsonArray } from './llm'
import { deliberationBatchPrompt, deliberationEvalPrompt } from './prompts'
import { activateEntries, type MemoryEntry } from './memory'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 查证来源：输入查询词，返回最多 3 条证据。可注入 dsh tool-web 或离线假实现。 */
export type EvidenceProvider = (query: string) => Promise<SearchResult[]>

/**
 * 普通词典词判定（方案 B）：全小写拉丁词且不在专名白名单 → 普通词，不推敲不锁定。
 * 含大写字母（专名）、或命中 scan.extra_proper_nouns（游戏特有设定词）的不算。
 */
export function isCommonDictionaryWord(source: string, extraProperNouns: string[]): boolean {
  const s = String(source ?? '').trim()
  if (!/[A-Za-z]/.test(s)) return false
  if (s !== s.toLowerCase()) return false
  const proper = new Set(
    (extraProperNouns ?? []).map((w) => String(w).trim().toLowerCase()).filter(Boolean),
  )
  return !proper.has(s.toLowerCase())
}

export interface DeliberationStats {
  evaluated: number
  auto_locked: number
  pending_approval: number
  failed: number
}

export function evidenceText(results: SearchResult[]): string {
  if (!results || results.length === 0) return '（无查证结果）'
  return results.slice(0, 3)
    .map((r) => `- ${r.title || ''}（${r.url || ''}）：${r.snippet || ''}`)
    .join('\n')
}

function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text)
}

function queryFor(source: string): string {
  return hasLatin(source) ? `"${source}" 翻译 中文 译名` : `${source} 译名`
}

function contextText(cand: Record<string, unknown>): string {
  const samples = Array.isArray(cand.samples) ? cand.samples.map(String) : []
  if (samples.length > 0) return samples.slice(0, 3).join('\n')
  return '（无语境样本）'
}

/** 用确认过的世界书条目按文本激活，拼成推敲背景（常驻 + 命中）。 */
function worldbookContext(worldbook: MemoryEntry[], text: string): string {
  const [constants, hits] = activateEntries(worldbook, text)
  const items = [...constants, ...hits]
  if (items.length === 0) return ''
  return items.map((e) => `【${String(e.title ?? '')}】${String(e.content ?? '')}`).join('\n')
}

interface Decision {
  target: string
  confidence: string
  rationale: string
  collision: string
}

function decisionFrom(data: Record<string, unknown>): Decision {
  return {
    target: String(data.target ?? '').trim(),
    confidence: String(data.confidence ?? 'low'),
    rationale: String(data.rationale ?? ''),
    collision: String(data.collision ?? ''),
  }
}

function applyDecision(
  db: ProjectDB,
  cand: Record<string, unknown>,
  data: Record<string, unknown>,
  stats: DeliberationStats,
): void {
  const source = String(cand.source ?? '').trim()
  const decision = decisionFrom(data)
  if (!decision.target) {
    stats.failed += 1
    return
  }
  // S13：落库前按 source 清理旧候选（含占位行 (source,'')），upsert 冲突键是
  // (source,target)，不清理则改译名会新增行、候选反复叠加翻倍。
  db.clearCandidateTermsBySource(source)
  db.upsertTerm(
    source,
    decision.target,
    String(cand.category ?? ''),
    'candidate',
    decision.confidence,
    decision.rationale,
  )
  stats.evaluated += 1
  const row = db.termBySourceTarget(source, decision.target)
  if (decision.confidence === 'high' && !decision.collision) {
    const id = Number(row?.id)
    if (Number.isFinite(id) && db.decideTerm(id, 'locked')) stats.auto_locked += 1
  } else {
    db.addApproval('term', {
      source,
      target: decision.target,
      confidence: decision.confidence,
      rationale: decision.rationale,
    })
    stats.pending_approval += 1
  }
}

async function evaluateOne(
  generate: Generate,
  db: ProjectDB,
  cand: Record<string, unknown>,
  evidence: EvidenceProvider,
  stats: DeliberationStats,
  worldbook: MemoryEntry[],
): Promise<void> {
  const source = String(cand.source ?? '').trim()
  try {
    const results = await evidence(queryFor(source))
    const wb = worldbookContext(worldbook, `${source}\n${contextText(cand)}`)
    const result = await generate.generate({
      system: deliberationEvalPrompt(),
      messages: [{
        role: 'user',
        content: [
          `候选：${source}`,
          `类别：${String(cand.category ?? '')}`,
          `出现次数：${String(cand.frequency ?? '?')}`,
          `出现语境：\n${contextText(cand)}`,
          `世界书背景：${wb ? '\n' + wb : '（无）'}`,
          `考量维度：用典、玩梗、文化、韵律、双关、短习俚等，综合判定译名。`,
          `查证证据：\n${evidenceText(results)}`,
        ].join('\n'),
      }],
    })
    applyDecision(db, cand, extractJson(result.text), stats)
  } catch {
    stats.failed += 1
  }
}

async function buildCandidateBlock(
  index: number,
  cand: Record<string, unknown>,
  evidence: EvidenceProvider,
  worldbook: MemoryEntry[],
): Promise<string> {
  const source = String(cand.source ?? '').trim()
  const results = await evidence(queryFor(source))
  const wb = worldbookContext(worldbook, `${source}\n${contextText(cand)}`)
  return [
    `${index}. 候选：${source}`,
    `类别：${String(cand.category ?? '')}`,
    `出现次数：${String(cand.frequency ?? '?')}`,
    `出现语境：\n${contextText(cand)}`,
    `世界书背景：${wb ? '\n' + wb : '（无）'}`,
    `考量维度：用典、玩梗、文化、韵律、双关、短习俚等，综合判定译名。`,
    `查证证据：\n${evidenceText(results)}`,
  ].join('\n')
}

async function evaluateBatch(
  generate: Generate,
  db: ProjectDB,
  batch: Array<Record<string, unknown>>,
  evidence: EvidenceProvider,
  stats: DeliberationStats,
  worldbook: MemoryEntry[],
): Promise<void> {
  const rows: string[] = []
  for (let i = 0; i < batch.length; i++) {
    rows.push(await buildCandidateBlock(i + 1, batch[i]!, evidence, worldbook))
  }
  try {
    const result = await generate.generate({
      system: deliberationBatchPrompt(rows.join('\n\n')),
      messages: [{ role: 'user', content: rows.join('\n\n') }],
    })
    const decisions = extractJsonArray(result.text)
    const bySource = new Map<string, Record<string, unknown>>()
    for (const d of decisions) {
      bySource.set(String(d.source ?? '').trim(), d)
    }
    for (const cand of batch) {
      const decision = bySource.get(String(cand.source ?? '').trim())
      if (!decision) {
        stats.failed += 1
        continue
      }
      applyDecision(db, cand, decision, stats)
    }
  } catch {
    // 批量失败逐条兜底，保证不丢候选（与 Python 一致）
    for (const cand of batch) await evaluateOne(generate, db, cand, evidence, stats, worldbook)
  }
}

/** 评估候选：查证 + LLM 多方位决策，结果写回 DB。返回统计。 */
export async function evaluateCandidates(
  generate: Generate,
  db: ProjectDB,
  cfg: EngineConfig,
  candidates?: Array<Record<string, unknown>>,
  evidence: EvidenceProvider = async () => [],
): Promise<DeliberationStats> {
  const source = candidates ?? db.pendingTerms()
  const items = source
    .map((c) => ({ ...c }))
    .filter((c) => String(c.source ?? '').trim())
    // 方案 B：普通词典词一律不推敲、不锁定（含 NSFW 高频词），白名单与专名照常。
    .filter((c) => !isCommonDictionaryWord(String(c.source ?? ''), cfg.scan.extraProperNouns))
  const stats: DeliberationStats = { evaluated: 0, auto_locked: 0, pending_approval: 0, failed: 0 }
  const batchSize = Math.max(1, Math.floor(cfg.deliberation.batchSize))
  // 推敲背景：确认过的世界书条目（常驻 + 按候选语境命中）。
  const worldbook = db.loadWorldbook()
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize)
    if (batch.length <= 1) {
      for (const cand of batch) await evaluateOne(generate, db, cand, evidence, stats, worldbook)
    } else {
      await evaluateBatch(generate, db, batch, evidence, stats, worldbook)
    }
  }
  return stats
}
