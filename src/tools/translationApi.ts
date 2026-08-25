/**
 * 翻译专用 API 的选择/解析/描述（dsh 层，依赖宿主服务与引擎层）：
 * - scope 选择器：决定某个调用点（主链路 / 知识检索）是否走专用 API；
 * - merge：yaml 配置层 + state.json 界面层的合并优先级（界面 > yaml > 空走宿主）；
 * - resolveTranslationGenerate：按配置就绪度构造专用 HTTP Generate 或宿主 ctx.llm。
 * 引擎层（src/engine/http.ts）保持无 dsh 依赖。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config, TranslationApiConfig, TranslationScope } from '../config'
import type { EngineConfig } from '../engine/config'
import { createDshGenerate, LLM_REQUEST_TIMEOUT_MS } from '../engine/dshLlm'
import { createHttpGenerate } from '../engine/http'
import type { Generate } from '../engine/llm'
import { CHANNEL_KEY_REF_PREFIX } from '../tav2Settings'

/** 调用点类型：主链路（tav2_translate_batch 的理解/重写/摘要/润色）或知识检索（tsKnowledge）。 */
export type TranslationCallSite = 'main-pipeline' | 'knowledge'

/**
 * scope 选择器：某调用点在给定 scope 下是否走专用 API。
 * - main（默认）/ all：主链路 + 世界书等知识类调用点都走专用 API（配了专用 API 就该直接用）；
 * - experimental：仅主链路走专用 API，知识类留在宿主（ts_jobs 强制单批直跑）。
 */
export function scopeEnablesDedicated(scope: TranslationScope | undefined, site: TranslationCallSite): boolean {
  // 主翻译链路：任何 scope 都启用专用 API。
  // 知识类（世界书）：默认（main/all/未设置）也启用——只有 experimental 才留在宿主。
  if (scope === 'experimental') return site === 'main-pipeline'
  return true
}

/** 合并 yaml + state.json 后的生效 API 配置：state.json（界面）字段优先，空走宿主。 */
export function mergeTranslationApi(
  yamlApi: TranslationApiConfig | undefined,
  stateApi: TranslationApiConfig | undefined,
): TranslationApiConfig {
  const y = yamlApi ?? {}
  const s = stateApi ?? {}
  const pickScope = (v: unknown): TranslationScope | undefined =>
    (v === 'main' || v === 'all' || v === 'experimental') ? (v as TranslationScope) : undefined
  return {
    baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : (typeof y.baseUrl === 'string' ? y.baseUrl : ''),
    model: typeof s.model === 'string' ? s.model : (typeof y.model === 'string' ? y.model : ''),
    scope: pickScope(s.scope) ?? pickScope(y.scope) ?? 'main',
    apiKeyEnv: typeof s.apiKeyEnv === 'string'
      ? s.apiKeyEnv
      : (typeof y.apiKeyEnv === 'string' ? y.apiKeyEnv : 'TRANSLATE_API_KEY'),
  }
}

/** 经 ctx.credentials 解析 API Key（宿主 credentials 域优先，process.env 兜底）。 */
export async function resolveApiKey(ctx: Context, apiKeyEnv: string | undefined): Promise<string | undefined> {
  const ref = (apiKeyEnv ?? '').trim()
  if (!ref) return undefined
  try {
    const creds = (ctx as unknown as {
      credentials?: { resolve?: (r: string) => Promise<{ value?: string } | undefined> }
    }).credentials
    const resolved = await creds?.resolve?.(ref)
    if (resolved?.value) return resolved.value
  } catch {
    // 回退 process.env
  }
  const env = process.env[ref]
  return env && env.trim() ? env : undefined
}

/** 专用 API 是否已配置可用：baseUrl 非空 + 需要密钥时密钥已配置（否则静默回退宿主）。 */
export async function dedicatedApiReady(ctx: Context, api: TranslationApiConfig): Promise<boolean> {
  if (!api.baseUrl || !api.baseUrl.trim()) return false
  if (api.apiKeyEnv && api.apiKeyEnv.trim()) {
    const key = await resolveApiKey(ctx, api.apiKeyEnv)
    if (!key) return false
  }
  return true
}

/** 构造某调用点的翻译 Generate：专用 API 可用则专用，否则回退宿主 ctx.llm。 */
export async function resolveTranslationGenerate(
  ctx: Context,
  config: Config,
  engineCfg: EngineConfig,
  site: TranslationCallSite,
): Promise<Generate> {
  const api = config.translationApi ?? {}
  const scopeOk = scopeEnablesDedicated(api.scope, site)
  let ready = scopeOk && Boolean(api.baseUrl && api.baseUrl.trim())
  let key: string | undefined
  if (ready && api.apiKeyEnv && api.apiKeyEnv.trim()) {
    key = await resolveApiKey(ctx, api.apiKeyEnv)
    if (!key) {
      // 专用 API 配了 baseUrl 但密钥解析不到：不再静默回退，明确警告，避免「LLM 调用失败」无头绪。
      console.warn(
        `[tav2] 翻译专用 API 已配置 baseUrl（${api.baseUrl}）但密钥引用「${api.apiKeyEnv}」解析不到；`
        + '已回退宿主 ctx.llm（这是「LLM 调用失败」的常见原因）。请在宿主凭据域配置该引用或设置同名环境变量。',
      )
      ready = false
    }
  }
  if (!ready) {
    return createDshGenerate(ctx, config.llmProvider, engineCfg.llm.model)
  }
  return createHttpGenerate({
    baseUrl: api.baseUrl!.trim(),
    model: (api.model ?? '').trim() || engineCfg.llm.model,
    apiKey: key,
    apiKeyEnv: api.apiKeyEnv,
    timeoutMs: engineCfg.llm.timeout * 1000 || LLM_REQUEST_TIMEOUT_MS,
  })
}

/** 同步描述当前翻译通道（供 tav2_status / /tav2-mode status 展示；不承诺密钥状态）。 */
export function describeChannelSync(config: Config, engineModel?: string): string {
  const api = config.translationApi ?? {}
  if (api.baseUrl && api.baseUrl.trim()) {
    const model = (api.model ?? '').trim() || engineModel || ''
    const ref = (api.apiKeyEnv ?? '').trim()
    // 渠道密钥引用形如 TAV2_<渠道名>（合法凭据引用，不含冒号）；本地免鉴权渠道 apiKeyEnv 留空。
    const channelName = ref.startsWith(CHANNEL_KEY_REF_PREFIX) ? ref.slice(CHANNEL_KEY_REF_PREFIX.length) : ''
    const keyNote = ref
      ? `（密钥=${channelName || ref}，未配置时静默回退宿主）`
      : '（本地模型，无鉴权）'
    return `翻译通道：${channelName ? `渠道「${channelName}」` : '专用 API'}（baseUrl=${api.baseUrl.trim()}${model ? ` / ${model}` : ''}${keyNote}，scope=${api.scope ?? 'main'}）`
  }
  return `翻译通道：宿主 ctx.llm（provider=${config.llmProvider}${engineModel ? ` / ${engineModel}` : ''}）`
}
