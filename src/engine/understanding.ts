/** 双阶段协议第一步：场景理解（结构化记录写入 DB）。 */

import type { EngineConfig } from './config'
import type { Generate } from './llm'
import { extractJson } from './llm'
import type { MemoryPack } from './memory'
import { UnderstandingRecord, type Scene } from './models'
import { understandingPrompt, styleInstruction } from './prompts'

/** 为场景生成结构化理解记录；解析失败返回 null（不阻塞翻译）。 */
export async function generateUnderstanding(
  generate: Generate,
  cfg: EngineConfig,
  scene: Scene,
  memory: MemoryPack,
  signal?: AbortSignal,
): Promise<UnderstandingRecord | null> {
  const sourceText = scene.units.filter((u) => u.source).map((u) => u.source).join('\n')
  if (!sourceText) return null
  const reasoning = cfg.context.understandingReasoningEffort || undefined
  try {
    const result = await generate.generate({
      // 场景级口吻判断：理解提示词注入翻译风格，要求产出 tone（场景文风指引）。
      system: understandingPrompt(styleInstruction(
        cfg.translation.stylePreset,
        cfg.translation.stylePrompt,
        cfg.translation.head,
      )),
      messages: [{ role: 'user', content: userMessage(scene, sourceText, memory) }],
      meta: { stage: 'understanding', sceneId: scene.scene_id },
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
      ...(signal ? { signal } : {}),
    })
    const data = extractJson(result.text)
    const record = UnderstandingRecord.fromDict({
      scene_id: scene.scene_id,
      scene_state: (data.scene_state ?? {}) as Record<string, unknown>,
      threads: (data.threads ?? []) as UnderstandingRecord['threads'],
      term_usage: (data.term_usage ?? []) as UnderstandingRecord['term_usage'],
      style_notes: (data.style_notes ?? []) as UnderstandingRecord['style_notes'],
      flags: (data.flags ?? []) as UnderstandingRecord['flags'],
      tone: String(data.tone ?? ''),
    })
    record.raw = data
    return record
  } catch {
    return null
  }
}

function userMessage(scene: Scene, sourceText: string, memory: MemoryPack): string {
  const parts = [
    `场景：${scene.title}`,
    `分支：${scene.branch}`,
  ]
  if (memory.summary) parts.push(`剧情摘要（前文）：\n${memory.summary}`)
  if (memory.mainSummary) parts.push(`主线摘要（分支前文）：\n${memory.mainSummary}`)
  if (memory.constants.length) {
    parts.push('常驻背景：\n' + memory.constants.map((e) => `【${e.title}】${e.content}`).join('\n'))
  }
  if (memory.loreHits.length) {
    parts.push('命中背景：\n' + memory.loreHits.map((e) => `【${e.title}】${e.content}`).join('\n'))
  }
  if (memory.glossary.length) {
    parts.push('锁定术语：\n' + memory.glossary.map(([s, t]) => `${s} → ${t}`).join('\n'))
  }
  parts.push(`场景原文：\n${sourceText}`)
  return parts.join('\n\n')
}
