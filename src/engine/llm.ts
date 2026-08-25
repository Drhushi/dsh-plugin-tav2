/**
 * 引擎侧的 LLM 抽象（与 dsh 无关，便于离线测试与未来独立）。
 * ts 实现接 ctx.llm（见 dshLlm.ts）；测试用 ScriptedGenerate。
 */

export interface EngineMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateRequest {
  /** 系统提示（对应 provider 的 system 槽） */
  system?: string
  messages: EngineMessage[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
  model?: string
  signal?: AbortSignal
}

export interface GenerateResult {
  text: string
  usage?: { promptTokens: number; completionTokens: number }
}

export interface Generate {
  generate(req: GenerateRequest): Promise<GenerateResult>
}

const AUX_PATTERNS = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<think>[\s\S]*?<\/think>/gi,
  /<!--[\s\S]*?-->/g,
]

/** 去除模型响应中的思考/注释块。 */
export function stripAux(content: string): string {
  let text = content ?? ''
  for (const pattern of AUX_PATTERNS) text = text.replace(pattern, '')
  return text.trim()
}

function unFence(text: string): string {
  let out = text
  if (out.startsWith('```')) {
    out = out.replace(/^```[a-zA-Z]*\s*/, '')
    out = out.replace(/\s*```$/, '')
  }
  return out
}

/** 从 LLM 响应中提取 JSON 对象（容错 markdown 围栏与前后缀）。 */
export function extractJson(content: string): Record<string, unknown> {
  const text = unFence(stripAux(content))
  const start = text.indexOf('{')
  if (start < 0) {
    throw new Error(`响应中未找到 JSON 对象：${content.slice(0, 200)}`)
  }
  // 取第一个完整 JSON 值：逐 `}` 尝试解析，首个成功即返回。
  // 兼容模型在 JSON 后追加说明/第二个对象（openCode 端点常见）导致末 `}` 失配。
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== '}') continue
    try {
      const parsed = JSON.parse(text.slice(start, i + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 未闭合/非法，继续找下一个 `}`
    }
  }
  throw new Error(`响应中未找到完整 JSON 对象：${content.slice(0, 200)}`)
}

/** 从 LLM 响应中提取 JSON 数组（容错 markdown 围栏与前后缀）。 */
export function extractJsonArray(content: string): Array<Record<string, unknown>> {
  const text = unFence(stripAux(content))
  const start = text.indexOf('[')
  if (start < 0) {
    throw new Error(`响应中未找到 JSON 数组：${content.slice(0, 200)}`)
  }
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== ']') continue
    try {
      const parsed = JSON.parse(text.slice(start, i + 1))
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
    } catch {
      // 继续找下一个 `]`
    }
  }
  throw new Error(`响应中未找到完整 JSON 数组：${content.slice(0, 200)}`)
}

/** LLM 用量与耗时记录（对应 Python BaseLLM.usage）。 */
export class UsageTracker {
  calls = 0
  promptTokens = 0
  completionTokens = 0
  elapsedSeconds = 0

  record(calls = 1, promptTokens = 0, completionTokens = 0, seconds = 0): void {
    this.calls += calls
    this.promptTokens += promptTokens
    this.completionTokens += completionTokens
    this.elapsedSeconds += seconds
  }

  snapshot(): { calls: number; prompt_tokens: number; completion_tokens: number } {
    return {
      calls: this.calls,
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
    }
  }

  totalTokens(): number {
    return this.promptTokens + this.completionTokens
  }
}

/** 包装一个 Generate，自动记录用量与耗时。 */
export class TrackedGenerate implements Generate {
  readonly usage = new UsageTracker()

  constructor(private readonly inner: Generate) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = performance.now()
    const result = await this.inner.generate(req)
    const elapsed = (performance.now() - started) / 1000
    this.usage.record(
      1,
      result.usage?.promptTokens ?? 0,
      result.usage?.completionTokens ?? 0,
      elapsed,
    )
    return result
  }
}

/** 测试用：按请求返回脚本化文本的 Generate。 */
export class ScriptedGenerate implements Generate {
  constructor(
    private readonly handler: (req: GenerateRequest) => string,
    private readonly usage?: { promptTokens?: number; completionTokens?: number },
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return {
      text: this.handler(req),
      usage: {
        promptTokens: this.usage?.promptTokens ?? 0,
        completionTokens: this.usage?.completionTokens ?? 0,
      },
    }
  }
}
