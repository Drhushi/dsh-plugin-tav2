import type {} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Generate, GenerateRequest } from './llm'

/**
 * 默认 LLM 请求级超时（毫秒）。provider 悬挂时放弃等待，避免翻译批次无限阻塞。
 */
export const LLM_REQUEST_TIMEOUT_MS = 120_000

/**
 * 请求级超时：工作与一个永不触发（除非先 reject）的定时器赛跑。
 * 超时即放弃等待并抛错；**不 abort 底层请求**（Windows 上 abort 不可靠，
 * 且放弃等待语义下后台请求自行结束即可）。败者后续的 settle 被 Promise.race
 * 内部消化，不会产生未处理拒绝。
 * @param work - 实际请求任务。
 * @param timeoutMs - 超时毫秒数。
 * @param message - 超时错误信息。
 * @returns 工作结果；超时则抛错。
 */
export async function withLlmTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message = 'LLM 请求超时',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把引擎的 Generate 请求映射到 dsh 的 ctx.llm.stream，并施加请求级超时。
 * @param ctx - 携带 llm 服务的 cordis 上下文。
 * @param provider - dsh 里注册的 LLM provider 名。
 * @param model - 模型名。
 * @param timeoutMs - 请求级超时毫秒数（默认 LLM_REQUEST_TIMEOUT_MS）。
 */
export function createDshGenerate(
  ctx: Context,
  provider: string,
  model: string,
  timeoutMs = LLM_REQUEST_TIMEOUT_MS,
): Generate {
  return {
    async generate(req: GenerateRequest) {
      const messages = req.messages.map((m) => ({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
      }))
      const work = (async () => {
        let text = ''
        let promptTokens = 0
        let completionTokens = 0
        for await (const chunk of ctx.llm.stream({
          provider,
          model,
          messages: messages as never,
          ...(req.system !== undefined ? { system: req.system } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort as never } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text
          else if (chunk.type === 'usage') {
            // dsh llm 流 usage 字段是 inputTokens/outputTokens（TokenUsage），
            // 兼容旧命名 promptTokens/completionTokens。
            const u = chunk.usage as {
              inputTokens?: number
              outputTokens?: number
              promptTokens?: number
              completionTokens?: number
            }
            promptTokens = u.inputTokens ?? u.promptTokens ?? 0
            completionTokens = u.outputTokens ?? u.completionTokens ?? 0
          } else if (chunk.type === 'finish'
            && (chunk.reason as unknown as { kind: string }).kind === 'error') {
            throw new Error('LLM 调用失败')
          }
        }
        return { text, usage: { promptTokens, completionTokens } }
      })()
      return withLlmTimeout(work, timeoutMs)
    },
  }
}
