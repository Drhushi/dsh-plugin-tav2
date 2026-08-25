/**
 * 设置卡（settings namespace `tav2`）的服务端 schema 与渠道解析。
 * - 用户态：翻译「渠道」列表（每个渠道=名称/接口地址/模型/覆盖范围）+ 当前渠道选择器，
 *   密钥存宿主凭据域（不暴露“引用名”，内部按渠道名派生引用）。
 * - 另含 Ren'Py SDK 路径（.rpyc 编译游戏 prepare 的依赖，覆盖 yaml 层 config.renpySdk）。
 * - schema：translationChannels + translationActiveChannel + renpySdk；
 *   scope 枚举校验；schema 不含任何密钥字段（密钥走宿主 credentials 域）。
 * - resolveChannelApi：把当前渠道映射成引擎消费的 TranslationApiConfig（state.json
 *   的 translationApi 通道），密钥引用名自动生成为 `TAV2_<渠道名>`（必须匹配 DSH
 *   凭据引用语法 `[A-Za-z_][A-Za-z0-9_]*`，不能含冒号）。
 */

import Schema from '@deepseek-ai/schemastery'
import type { TranslationApiConfig, TranslationScope } from './config'

/** 一个翻译渠道（用户态字段，密钥不在此）。 */
export interface TranslationChannelInput {
  name: string
  baseUrl: string
  model: string
  scope: TranslationScope
}

export const tav2ChannelSchema: Schema<TranslationChannelInput> = Schema.object({
  name: Schema.string(),
  baseUrl: Schema.string(),
  model: Schema.string().default(''),
  scope: Schema.union(['main', 'all', 'experimental']).default('main'),
})

export const tav2SettingsSchema = Schema.object({
  /** 渠道列表；当前渠道为空串=走宿主（dsh 主密钥/ctx.llm）。 */
  translationChannels: Schema.array(tav2ChannelSchema).default([]),
  /** 当前渠道名；空串=宿主。 */
  translationActiveChannel: Schema.string().default(''),
  /** Ren'Py SDK 绝对路径（.rpyc 编译游戏 prepare 需要）；空=回退插件 yaml 的 renpySdk。 */
  renpySdk: Schema.string().default(''),
})

/**
 * 密钥引用名前缀（用户不可见，按渠道名派生）。
 * 必须满足 DSH 凭据引用语法（REF_PATTERN=/^[A-Za-z_][A-Za-z0-9_]*$/）：
 * 旧值 'tav2:' 含冒号不合法，导致 ctx.credentials.resolve 永远解析不到、静默回退宿主。
 */
export const CHANNEL_KEY_REF_PREFIX = 'TAV2_'

/**
 * 把当前渠道映射成引擎的 TranslationApiConfig：
 * - 当前渠道不存在/缺 baseUrl → undefined（走宿主，yaml 层 translationApi 兜底）；
 * - 有 → baseUrl/model/scope + apiKeyEnv=`TAV2_<渠道名>`（凭据域解析）。
 */
export function resolveChannelApi(channels: unknown, active: unknown): TranslationApiConfig | undefined {
  if (typeof active !== 'string' || !active.trim()) return undefined
  const list = Array.isArray(channels) ? channels : []
  const ch = list.find((c) => c && typeof c === 'object' && (c as { name?: unknown }).name === active)
  if (!ch || typeof ch !== 'object') return undefined
  const v = ch as { baseUrl?: unknown; model?: unknown; scope?: unknown }
  const baseUrl = typeof v.baseUrl === 'string' ? v.baseUrl.trim() : ''
  if (!baseUrl) return undefined
  const out: TranslationApiConfig = { baseUrl, apiKeyEnv: `${CHANNEL_KEY_REF_PREFIX}${active}` }
  if (typeof v.model === 'string' && v.model.trim()) out.model = v.model.trim()
  if (v.scope === 'main' || v.scope === 'all' || v.scope === 'experimental') {
    out.scope = v.scope as TranslationScope
  }
  return out
}

/** 渠道名 → 凭据引用名（供凭据域读写）。 */
export function channelKeyRef(name: string): string {
  return `${CHANNEL_KEY_REF_PREFIX}${name}`
}
