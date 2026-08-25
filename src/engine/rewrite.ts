/** 双阶段协议第二步：据理解记录与记忆逐条重写，含完整性/标签硬校验与补译。 */

import type { EngineConfig } from './config'
import { ensureTranslationTag, stripLeadingSpeakerTag, tagsPreserved } from './gates'
import type { Generate } from './llm'
import { extractJson } from './llm'
import type { MemoryPack } from './memory'
import type { Scene, UnderstandingRecord, Unit } from './models'
import { langLabel, rewritePrompt, styleInstruction } from './prompts'

export const MAX_RETRY_ROUNDS = 3

export interface RewriteFailureEvent {
  /** 本轮仍未产出的单元 id。 */
  unitIds: string[]
  reason: string
  /** 第几轮失败（0 起）。 */
  round: number
}

/**
 * 重写场景（或指定子批）单元，返回 {unit_id: 译文}（已通过标签与完整性校验）。
 * onFailure 用于把静默重试变成可观测日志；调用方仍需据返回结果处置最终失败单元。
 */
export async function rewriteScene(
  generate: Generate,
  cfg: EngineConfig,
  scene: Scene,
  memory: MemoryPack,
  understanding: UnderstandingRecord | null,
  units?: Unit[],
  signal?: AbortSignal,
  onFailure?: (event: RewriteFailureEvent) => void,
): Promise<Record<string, string>> {
  const pending = (units ?? scene.units).filter((u) => u.source)
  const result: Record<string, string> = {}
  for (let round = 0; round <= MAX_RETRY_ROUNDS; round += 1) {
    const missing = pending.filter((u) => !(u.unit_id in result))
    if (missing.length === 0) break
    const prompt = rewritePrompt(langLabel(cfg.lang), styleInstruction(cfg.translation.stylePreset, cfg.translation.stylePrompt, cfg.translation.head))
    const user = userMessage(scene, missing, memory, understanding, round, cfg)
    let data: Record<string, unknown>
    try {
      const response = await generate.generate({
        system: prompt,
        messages: [{ role: 'user', content: user }],
        ...(signal ? { signal } : {}),
      })
      data = extractJson(response.text)
    } catch (err) {
      onFailure?.({
        unitIds: missing.map((u) => u.unit_id),
        reason: String(err instanceof Error ? err.message : err).slice(0, 200),
        round,
      })
      continue
    }
    const sources: Record<string, string> = {}
    for (const unit of missing) sources[unit.unit_id] = unit.source
    for (const [key, value] of Object.entries(data)) {
      const unitId = key.trim()
      const text = String(value ?? '').trim()
      const srcText = sources[unitId]
      if (!text || srcText === undefined) continue
      if (!tagsPreserved(srcText, text)) continue
      result[unitId] = stripLeadingSpeakerTag(srcText, ensureTranslationTag(srcText, text))
    }
  }
  return result
}

function userMessage(
  scene: Scene,
  units: Unit[],
  memory: MemoryPack,
  understanding: UnderstandingRecord | null,
  roundIndex: number,
  cfg: EngineConfig,
): string {
  const parts: string[] = []
  if (roundIndex === 0) {
    parts.push(`场景：${scene.title}`)
    const contextText = sceneContextText(scene, units, cfg)
    if (contextText) parts.push(`【场景上下文】\n${contextText}`)
    if (memory.summary) parts.push(`剧情摘要（前文）：\n${memory.summary}`)
    if (memory.mainSummary) parts.push(`主线摘要（分支前文）：\n${memory.mainSummary}`)
    if (understanding) parts.push(`【理解记录】\n${understandingText(understanding)}`)
    // 方案 C 精简供给：常驻背景不注入重写（理解阶段已消化），向量召回只留 top-1，
    // 最近场景理解保留（跨场景一致性参考）。
    if (memory.loreHits.length) {
      parts.push('命中背景：\n' + memory.loreHits.map((e) => `【${e.title}】${e.content}`).join('\n'))
    }
    if (memory.glossary.length) {
      parts.push('锁定术语：\n' + memory.glossary.map(([s, t]) => `${s} → ${t}`).join('\n'))
    }
    if (memory.recentUnderstandings.length) {
      parts.push('最近场景理解（跨场景一致性参考）：\n'
        + memory.recentUnderstandings.map((r) => `[${r.scene_id}]\n${understandingText(r)}`).join('\n'))
    }
    if (memory.vectorHits.length) {
      parts.push('向量召回（top-1）：\n'
        + memory.vectorHits.slice(0, 1).map((e) => `【${e.title ?? e.kind}】${e.content}`).join('\n'))
    }
    if (memory.fewShot.length) {
      const lines = ['已译句对示例：']
      for (const [source, translated] of memory.fewShot) {
        lines.push(`源: ${source}`)
        lines.push(`译: ${translated}`)
      }
      parts.push(lines.join('\n'))
    }
    parts.push('待译文本（整块理解后逐条重写，保持整体一致）：')
  } else {
    parts.push('以下标识符上一轮缺失或未通过校验，请补齐：')
  }
  for (const unit of units) {
    parts.push(`${unit.unit_id}: ${unit.source}`)
    if (unit.speaker) parts.push(`说话人：${unit.speaker}`)
  }
  return parts.join('\n\n')
}

function sceneContextText(scene: Scene, units: Unit[], cfg: EngineConfig): string {
  if (cfg.engine !== 'renpy') return ''
  const label = scene.scene_id.includes('::')
    ? scene.scene_id.split('::', 2)[1]
    : ''
  if (!label || label === 'noaddr') return ''
  const ordered = scene.units.filter((u) => u.source)
  const neighbors = (unit: Unit): { prev: string; next: string } => {
    const idx = ordered.findIndex((x) => x.unit_id === unit.unit_id)
    const prev = ordered.slice(Math.max(0, idx - 2), idx).map((x) => x.source).join(' | ')
    const next = ordered.slice(idx + 1, idx + 3).map((x) => x.source).join(' | ')
    return { prev, next }
  }
  const lines = [`label=${label}（仅作语境参考，不参与翻译）`]
  for (const unit of units.slice(0, 2)) {
    const { prev } = neighbors(unit)
    if (prev) lines.push(`${unit.unit_id} 前文: ${prev.slice(0, 180)}`)
  }
  for (const unit of units.slice(-2)) {
    const { next } = neighbors(unit)
    if (next) lines.push(`${unit.unit_id} 后文: ${next.slice(0, 180)}`)
  }
  return lines.join('\n')
}

function understandingText(record: UnderstandingRecord): string {
  const lines: string[] = []
  if (Object.keys(record.scene_state).length) {
    lines.push('场景状态：' + Object.entries(record.scene_state).map(([k, v]) => `${k}: ${v}`).join('；'))
  }
  for (const thread of record.threads) lines.push(`伏笔[${thread.kind}] ${thread.text}`)
  for (const usage of record.term_usage) lines.push(`术语：${usage.source} → ${usage.target}`)
  for (const note of record.style_notes) lines.push(`风格[${note.speaker}] ${note.note}`)
  return lines.join('\n') || '（无）'
}
