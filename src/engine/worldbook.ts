/**
 * 世界书（与 Python tav2/worldbook.py 对齐）：
 * 条目模型、LLM 分块生成、去重/常量上限、覆盖率报告。
 * 关键词激活复用 memory.ts 的 activateEntries。
 */

import type { EngineConfig } from './config'
import type { Generate } from './llm'
import { extractJsonArray } from './llm'
import { worldbookPrompt } from './prompts'
import { worldbookTermsPrompt } from './prompts'
import { findOccurrences } from './scanning'
import { estimateTokens } from './tokens'

export const VALID_LORE_KINDS = ['name', 'term', 'setting', 'lore'] as const
export type LoreKind = (typeof VALID_LORE_KINDS)[number]

export interface LoreEntry {
  kind: string
  title: string
  keywords: string[]
  content: string
  source_refs: string[]
}

export function loreEntryFromDict(data: Record<string, unknown>): LoreEntry {
  return {
    kind: String(data.kind ?? 'lore'),
    title: String(data.title ?? ''),
    keywords: Array.isArray(data.keywords) ? data.keywords.map((k) => String(k)) : [],
    content: String(data.content ?? ''),
    source_refs: Array.isArray(data.source_refs) ? data.source_refs.map((r) => String(r)) : [],
  }
}

export function toMemoryEntry(entry: LoreEntry): Record<string, unknown> {
  return { ...entry }
}

/** 按 token 预算把原文行切成顺序块（与 Python _chunk_lines 同口径）。 */
export function chunkLines(lines: string[], maxTokens: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let total = 0
  for (const line of lines) {
    const cost = estimateTokens(line) + 8
    if (current.length > 0 && total + cost > maxTokens) {
      chunks.push(current)
      current = []
      total = 0
    }
    current.push(line)
    total += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 规范化单条世界书条目。 */
export function cleanEntry(entry: LoreEntry, maxChars: number): LoreEntry {
  const kind = VALID_LORE_KINDS.includes(entry.kind as LoreKind) ? entry.kind : 'lore'
  return {
    kind,
    title: entry.title.trim().slice(0, 60),
    content: entry.content.trim().slice(0, maxChars),
    keywords: entry.keywords.map((k) => String(k).trim()).filter((k) => k.length > 0),
    source_refs: entry.source_refs.map((r) => String(r).trim()).filter((r) => r.length > 0),
  }
}

/** 按标题/关键词去重，并按常量上限把前几条 setting/lore 提升为 constant。 */
export function dedupeEntries(
  entries: LoreEntry[],
  cfg: { maxConstants: number },
): LoreEntry[] {
  const maxConstants = Math.max(0, Math.floor(cfg.maxConstants || 0))
  const seenTitles = new Set<string>()
  const seenKeywords = new Set<string>()
  const out: LoreEntry[] = []
  let constantCount = 0
  for (const raw of entries) {
    const entry = { ...raw, keywords: [...raw.keywords], source_refs: [...raw.source_refs] }
    const titleKey = entry.title.replace(/[（(].*?[)）]/g, '').trim().toLowerCase()
    if (!titleKey || seenTitles.has(titleKey)) continue
    seenTitles.add(titleKey)
    const kwHit = entry.keywords.some((k) => seenKeywords.has(k.toLowerCase()))
    if (kwHit) continue
    for (const k of entry.keywords) seenKeywords.add(k.toLowerCase())
    if ((entry.kind === 'setting' || entry.kind === 'lore') && constantCount < maxConstants) {
      entry.kind = 'constant'
      constantCount += 1
    }
    out.push(entry)
  }
  return out
}

/** 分块用 LLM 生成世界书条目；单块失败跳过（与 Python 一致）。 */
export async function generateWorldbook(
  generate: Generate,
  cfg: EngineConfig,
  lines: string[],
  onProgress?: (done: number, total: number) => void,
  lockedTerms?: Array<[string, string]>,
  onError?: (index: number, message: string) => void,
): Promise<LoreEntry[]> {
  const maxChars = cfg.worldbook.maxContentChars
  const chunks = chunkLines(lines, cfg.worldbook.chunkTokens)
  const entries: LoreEntry[] = []
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!
    onProgress?.(index + 1, chunks.length)
    const system = worldbookPrompt(maxChars)
    const constraint = lockedTerms && lockedTerms.length > 0
      ? `以下译名已锁定，世界书条目标题/内容涉及这些名称时必须采用、不得另译：\n`
        + lockedTerms.map(([s, t]) => `  ${s} → ${t}`).join('\n') + '\n\n'
      : ''
    const user = `${constraint}源文本片段：\n${chunk.join('\n')}`
    try {
      const result = await generate.generate({
        system,
        messages: [{ role: 'user', content: user }],
        reasoningEffort: cfg.worldbook.reasoningEffort || undefined,
      })
      for (const item of extractJsonArray(result.text)) {
        const entry = cleanEntry(loreEntryFromDict(item), maxChars)
        if (entry.title && (entry.content || entry.keywords.length > 0)) entries.push(entry)
      }
    } catch (err) {
      // LLM 调用/解析失败：跳过该块，但上报失败原因（不再静默吞错）。
      onError?.(index, String(err instanceof Error ? err.message : err))
    }
  }
  return dedupeEntries(entries, cfg.worldbook)
}

export interface CoverageReport {
  entries: number
  source_files: number
  source_lines: number
  files_referenced: number
  file_coverage: number
  warnings: string[]
}

/** 世界书覆盖率报告：条目数 / 来源文件数 / 引用文件数与告警。 */
export function coverageReport(
  entries: Array<LoreEntry | Record<string, unknown>>,
  sourceFiles: number,
  sourceLines: number,
): CoverageReport {
  const referenced = new Set<string>()
  for (const raw of entries) {
    const entry = 'source_refs' in raw ? raw as LoreEntry : raw
    for (const ref of Array.isArray(entry.source_refs) ? entry.source_refs : []) {
      const file = String(ref).split(':', 1)[0]!.trim()
      if (file) referenced.add(file)
    }
  }
  const files = Math.max(0, Math.floor(sourceFiles))
  const filesReferenced = referenced.size
  return {
    entries: entries.length,
    source_files: files,
    source_lines: Math.floor(sourceLines),
    files_referenced: filesReferenced,
    file_coverage: files > 0 ? Math.round(filesReferenced / files * 1000) / 1000 : 0,
    warnings: coverageWarnings(entries.length, files, filesReferenced),
  }
}

/** 覆盖率护栏告警：条目/文件过少、引用缺失时明确提示。 */
export function coverageWarnings(
  entriesCount: number,
  sourceFiles: number,
  filesReferenced: number,
): string[] {
  const warnings: string[] = []
  if (sourceFiles <= 0) warnings.push('来源文件数为 0，覆盖率无法计算')
  if (sourceFiles >= 5 && entriesCount < Math.max(3, Math.floor(sourceFiles / 5))) {
    warnings.push(`世界书条目数过少：${entriesCount} 条（来源文件 ${sourceFiles} 个）`)
  }
  if (filesReferenced === 0) warnings.push('无条目带来源引用（source_refs 为空），覆盖不可审计')
  return warnings
}
