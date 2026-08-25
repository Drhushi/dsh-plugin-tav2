/**
 * 混合检索（与 Python tav2/memory.py 对齐）：
 * 摘要 + 世界书关键词激活 + 锁定术语 + TM few-shot + 最近理解 + 向量兜底。
 * embedding 未配置或调用失败时静默降级为 []。
 */

import type { EngineConfig } from './config'
import type { ProjectDB } from './db'
import type { Scene, UnderstandingRecord } from './models'

export type MemoryEntry = Record<string, unknown>

/** 向量索引：候选条目 + 其嵌入向量。 */
export type VectorIndex = Array<[MemoryEntry, number[]]>

/** 文本向量化函数（可注入，便于离线测试）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

export interface MemoryPack {
  summary: string
  /** 分支场景携带的主线摘要（合并点上下文） */
  mainSummary: string
  constants: MemoryEntry[]
  loreHits: MemoryEntry[]
  glossary: Array<[string, string, string]>
  fewShot: Array<[string, string]>
  recentUnderstandings: UnderstandingRecord[]
  /** 向量召回（embedding 未配置时为空） */
  vectorHits: MemoryEntry[]
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termHits(source: string, joined: string): boolean {
  if (!source || source.length < 2) return false
  if (/[A-Za-z]/.test(source)) {
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(source)}(?![A-Za-z0-9_])`).test(joined)
  }
  return joined.includes(source)
}

/** 按原文关键词词边界激活条目。返回 (常驻, 命中)。 */
export function activateEntries(entries: MemoryEntry[], text: string): [MemoryEntry[], MemoryEntry[]] {
  const constants: MemoryEntry[] = []
  const hits: MemoryEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'constant') {
      constants.push(entry)
      continue
    }
    for (const raw of (entry.keywords as unknown[] | undefined) ?? []) {
      const kw = String(raw ?? '').trim()
      if (!kw) continue
      if (/[A-Za-z]/.test(kw)) {
        if (new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(kw)}(?![A-Za-z0-9_])`, 'i').test(text)) {
          hits.push(entry)
          break
        }
      } else if (text.includes(kw)) {
        hits.push(entry)
        break
      }
    }
  }
  return [constants, hits]
}

function fewShot(db: ProjectDB, unitSources: string[], maxPairs: number): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const source of unitSources) {
    const translation = db.tmGet(source)
    if (translation && translation !== source) pairs.push([source, translation])
    if (pairs.length >= maxPairs) break
  }
  return pairs
}

/** 向量索引候选 = 世界书条目 + 最近理解记录（序列化为可检索文本）。 */
export function _indexCandidates(
  worldbook: MemoryEntry[],
  recentUnderstandings: UnderstandingRecord[],
): MemoryEntry[] {
  const candidates: MemoryEntry[] = []
  for (const entry of worldbook) {
    candidates.push({
      kind: String(entry.kind ?? 'lore'),
      title: String(entry.title ?? ''),
      keywords: Array.isArray(entry.keywords) ? [...(entry.keywords as unknown[])] : [],
      content: String(entry.content ?? ''),
      source_refs: Array.isArray(entry.source_refs) ? [...(entry.source_refs as unknown[])] : [],
    })
  }
  for (const rec of recentUnderstandings) {
    const text = JSON.stringify(
      {
        state: rec.scene_state,
        threads: rec.threads.map((t) => ({
          id: t.id,
          kind: t.kind,
          text: t.text,
          scenes_since: t.scenes_since,
        })),
      },
      null,
      0,
    )
    candidates.push({
      kind: 'understanding',
      title: `理解:${rec.scene_id}`,
      keywords: [],
      content: text,
      source_refs: [],
    })
  }
  return candidates
}

/** 把候选条目批量向量化，返回 [(entry, vec)]（失败/空向量条目跳过）。 */
export async function buildVectorIndex(
  entries: MemoryEntry[],
  embed: EmbedFn,
): Promise<VectorIndex> {
  if (entries.length === 0) return []
  const texts = entries.map((e) => String(e.content ?? '') || String(e.title ?? ''))
  let vecs: number[][]
  try {
    vecs = (await embed(texts)) ?? []
  } catch {
    return []
  }
  if (!vecs || vecs.length === 0) return []
  const out: VectorIndex = []
  for (let i = 0; i < entries.length; i++) {
    const vec = vecs[i]
    if (vec && vec.length > 0) out.push([entries[i]!, vec])
  }
  return out
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 余弦相似度 top-k 召回（严格高于 min_score 才保留，与 Python 一致）。 */
export function vectorSearch(
  queryVec: number[],
  index: VectorIndex,
  topK: number,
  minScore = 0.5,
): MemoryEntry[] {
  const scored: Array<{ score: number; entry: MemoryEntry }> = []
  for (const [entry, vec] of index) {
    const score = cosine(queryVec, vec)
    if (score > minScore) scored.push({ score, entry })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, topK)).map((s) => s.entry)
}

/** 按引擎配置调用 OpenAI 兼容 /embeddings；未配置/无 key/失败静默返回 []。 */
export async function embedTexts(cfg: EngineConfig, texts: string[]): Promise<number[][]> {
  if (!cfg.memory.vectorEnabled) return []
  const model = cfg.memory.embeddingModel.trim()
  if (!model || texts.length === 0) return []
  const key = cfg.llm.apiKey
    || (cfg.llm.apiKeyEnv ? process.env[cfg.llm.apiKeyEnv] ?? '' : '')
    || process.env.TRANSLATE_AGENT_API_KEY
    || ''
  if (!key) return []
  try {
    const response = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(Math.max(1, cfg.llm.timeout) * 1000),
    })
    if (!response.ok) return []
    const data = await response.json() as {
      data?: Array<{ embedding?: number[] }>
    }
    return (data.data ?? [])
      .map((item) => item.embedding ?? [])
      .filter((vec) => Array.isArray(vec) && vec.length > 0)
  } catch {
    return []
  }
}

async function vectorHits(
  cfg: EngineConfig,
  candidates: MemoryEntry[],
  unitSources: string[],
): Promise<MemoryEntry[]> {
  if (candidates.length === 0 || unitSources.length === 0) return []
  const queryVecs = await embedTexts(cfg, [unitSources.join('\n')])
  if (queryVecs.length === 0) return []
  const index = await buildVectorIndex(candidates, (texts) => embedTexts(cfg, texts))
  if (index.length === 0) return []
  return vectorSearch(queryVecs[0]!, index, cfg.memory.topK)
}

/** 为场景组装记忆包（M4：向量兜底已启用，失败静默降级）。 */
export async function buildMemoryPack(
  db: ProjectDB,
  cfg: EngineConfig,
  scene: Scene,
  unitSources: string[],
  mainBranch = 'main',
): Promise<MemoryPack> {
  const pack: MemoryPack = {
    summary: db.getSummary(scene.branch),
    mainSummary: '',
    constants: [],
    loreHits: [],
    glossary: [],
    fewShot: [],
    recentUnderstandings: [],
    vectorHits: [],
  }
  if (scene.branch !== mainBranch) {
    pack.mainSummary = db.getSummary(mainBranch)
  }
  const worldbook = db.loadWorldbook()
  const joined = unitSources.join('\n')
  ;[pack.constants, pack.loreHits] = activateEntries(worldbook, joined)

  const locked = db.lockedTerms()
  pack.glossary = locked
    .filter((t) => termHits(String(t.source ?? ''), joined))
    .map((t) => [String(t.source ?? ''), String(t.target ?? ''), String(t.category ?? '')])

  pack.recentUnderstandings = db.recentUnderstandings(scene.branch, 3)
  pack.fewShot = fewShot(db, unitSources, cfg.context.fewShotPairs)
  const candidates = _indexCandidates(worldbook, pack.recentUnderstandings)
  pack.vectorHits = await vectorHits(cfg, candidates, unitSources)
  return pack
}
