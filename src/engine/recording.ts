/**
 * 请求录制器（A/B 审计）：把每次 LLM 调用的完整请求（system + messages 全文 + 采样参数）
 * 与响应/用量落盘为 JSONL，供「翻译结构 A/B 效果对比」审计与事后回放。
 * 默认不启用（config debug.request_snapshot_dir 为空时 runTranslate 不包录制层）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Generate, GenerateRequest, GenerateResult } from './llm'

export interface RequestSnapshot {
  /** 自增序号（1 起，按调用顺序）。 */
  seq: number
  /** 调用阶段：understanding | rewrite | polish | summary | … */
  stage?: string
  sceneId?: string
  round?: number
  model?: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
  system?: string
  messages: Array<{ role: string; content: string }>
  response_text: string
  usage: { promptTokens: number; completionTokens: number }
  elapsed_ms: number
  error?: string
}

export type SnapshotWriter = (record: RequestSnapshot) => void

/** 把快照追加写入指定文件（自动建父目录；UTF-8 JSONL，一行一条）。 */
export function jsonlRecorder(filePath: string): SnapshotWriter {
  mkdirSync(dirname(filePath), { recursive: true })
  return (record) => {
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  }
}

/** 包装一个 Generate，每次调用前/后把完整请求与响应写入快照（与 TrackedGenerate 同构，只录不改）。 */
export class RecordingGenerate implements Generate {
  private seq = 0

  constructor(
    private readonly inner: Generate,
    private readonly write: SnapshotWriter,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = performance.now()
    this.seq += 1
    const base = {
      seq: this.seq,
      stage: req.meta?.stage,
      sceneId: req.meta?.sceneId,
      round: req.meta?.round,
      model: req.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      reasoningEffort: req.reasoningEffort,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    try {
      const result = await this.inner.generate(req)
      this.write({
        ...base,
        response_text: result.text,
        usage: {
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
        },
        elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      })
      return result
    } catch (err) {
      this.write({
        ...base,
        response_text: '',
        usage: { promptTokens: 0, completionTokens: 0 },
        elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
        error: String(err instanceof Error ? err.message : err),
      })
      throw err
    }
  }
}
