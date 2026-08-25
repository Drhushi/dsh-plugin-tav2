/**
 * OpenAI 兼容 HTTP Generate（src/engine 层，无 dsh 依赖，可离线单测）：
 * - 纯 fetch POST <baseUrl>/chat/completions；
 * - `Bearer <apiKey>`（apiKey 显式优先，否则 process.env[apiKeyEnv] 兜底）；
 * - 请求级超时（默认 120s，复用 withLlmTimeout，不 abort 底层请求）；
 * - usage 统计 + 与 extractJson 相同的宽容响应解析（非 JSON 体自动找 JSON 对象）。
 */

import { withLlmTimeout, LLM_REQUEST_TIMEOUT_MS } from './dshLlm'
import type { Generate, GenerateRequest, GenerateResult } from './llm'
import { extractJson } from './llm'

export interface HttpGenerateOptions {
  baseUrl: string
  model: string
  /** 显式 API Key（优先于 process.env[apiKeyEnv]）。 */
  apiKey?: string
  /** 取密钥的环境变量名（apiKey 未提供时读取 process.env 兜底）。 */
  apiKeyEnv?: string
  /** 请求级超时毫秒（默认 LLM_REQUEST_TIMEOUT_MS）。 */
  timeoutMs?: number
}

/** 构造 OpenAI 兼容 HTTP 的引擎 Generate。 */
export function createHttpGenerate(options: HttpGenerateOptions): Generate {
  const base = options.baseUrl.replace(/\/+$/, '')
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  const timeoutMs = options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS
  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const work = (async () => {
        const apiKey = options.apiKey || (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined)
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (apiKey) headers.authorization = `Bearer ${apiKey}`
        const messages: Array<{ role: string; content: string }> = []
        if (req.system) messages.push({ role: 'system', content: req.system })
        for (const m of req.messages) messages.push({ role: m.role, content: m.content })
        const body: Record<string, unknown> = {
          model: options.model,
          messages,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        }
        const controller = new AbortController()
        const onAbort = (): void => {
          controller.abort()
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          if (!res.ok) {
            let detail = ''
            try {
              detail = (await res.text()).slice(0, 200)
            } catch {
              // 响应体不可读不阻断错误上抛
            }
            const hint = res.status === 401 || res.status === 403
              ? `翻译 API 鉴权失败（HTTP ${res.status}）：请到「设置 → 插件 → 翻译渠道」检查该渠道的密钥/凭据`
              : `翻译 API 请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`
            throw new Error(hint)
          }
          let data: Record<string, unknown>
          // body 是一次性流：只读一次 res.text()，先试 JSON.parse，失败再走宽容解析。
          const bodyText = await res.text()
          try {
            data = JSON.parse(bodyText) as Record<string, unknown>
          } catch {
            // 非 JSON 体：与 extractJson 相同宽容解析
            data = extractJson(bodyText)
          }
          const choices = Array.isArray(data.choices)
            ? data.choices as Array<{ message?: { content?: unknown } }>
            : []
          const raw = choices[0]?.message?.content
          const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw))
          const usageRaw = (data.usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown }
          return {
            text,
            usage: {
              promptTokens: typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : 0,
              completionTokens: typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : 0,
            },
          }
        } catch (err) {
          // 网络层错误（Node fetch 抛 TypeError: fetch failed）转成可操作的诊断指引：
          // 端用户遇到「翻译失败」时能直接知道去检查通道配置/本地服务，而不是看到裸的 fetch failed。
          if (err instanceof TypeError && /fetch/i.test(String(err.message))) {
            throw new Error(
              `LLM 翻译通道不可达（${endpoint}）：请检查翻译渠道 baseUrl 是否可达、本地服务是否已启动`,
            )
          }
          throw err
        } finally {
          req.signal?.removeEventListener('abort', onAbort)
        }
      })()
      return withLlmTimeout(work, timeoutMs)
    },
  }
}
