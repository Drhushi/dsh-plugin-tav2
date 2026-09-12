/**
 * tav2kit CLI 侧 LLM 直连（SPEC-STANDALONE Phase 2 LLM 直连收口）：
 * 渠道唯一来源是项目 config.yaml 的 translationApi 段（tav2kit config set translationApi.* 写入），
 * 密钥走环境变量（apiKeyEnv 指定的变量名，值永不落盘）。无"宿主回退"分支——
 * 渠道未配置/密钥缺失一律明确报错（fail-closed），doctor 负责报告渠道就绪度。
 * 引擎侧 createHttpGenerate（engine/http.ts）无 dsh 依赖，是 CLI 侧唯一 LLM 实现。
 */
import { join } from 'node:path'
import type { Config } from '../config'
import { createHttpGenerate } from '../engine/http'
import type { EngineConfig } from '../engine/config'
import type { Generate } from '../engine/llm'
import { loadRaw } from './config'

/** 读 config.yaml 顶层 translationApi 段（config set 写入的面；无则视为未配置）。 */
function readTranslationApi(config: Config): { baseUrl?: string; model?: string; apiKeyEnv?: string } {
  const configPath = join(config.projectDir, 'config.yaml')
  const raw = loadRaw(configPath)
  const api = raw?.translationApi
  if (!api || typeof api !== 'object' || Array.isArray(api)) return {}
  const str = (k: string): string | undefined => {
    const v = (api as Record<string, unknown>)[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  return {
    baseUrl: str('baseUrl'),
    model: str('model'),
    apiKeyEnv: str('apiKeyEnv'),
  }
}

/**
 * 构造 CLI 侧 LLM Generate（唯一实现 = OpenAI 兼容 HTTP 直连）。
 * 未配置 baseUrl → 抛错（可操作，指向 config set）；apiKeyEnv 指定的密钥 env 缺失 → 抛错。
 */
export function resolveCliGenerate(config: Config, engineCfg: EngineConfig): Generate {
  const api = readTranslationApi(config)
  if (!api.baseUrl) {
    throw new Error(
      '未配置翻译渠道（LLM 直连无宿主回退）。配置：tav2kit config set translationApi.baseUrl <接口地址> '
      + '[--yes]（可加 config set translationApi.model <模型名>；本地免鉴权渠道密钥留空）。',
    )
  }
  let apiKey: string | undefined
  if (api.apiKeyEnv) {
    const env = process.env[api.apiKeyEnv]
    if (!env || !env.trim()) {
      throw new Error(
        `翻译渠道已配置 baseUrl（${api.baseUrl}）但密钥环境变量「${api.apiKeyEnv}」未设置。`
        + '本地免鉴权渠道可把 config set translationApi.apiKeyEnv 留空。',
      )
    }
    apiKey = env.trim()
  }
  return createHttpGenerate({
    baseUrl: api.baseUrl,
    model: api.model ?? engineCfg.llm.model,
    apiKey,
    apiKeyEnv: api.apiKeyEnv,
    timeoutMs: engineCfg.llm.timeout * 1000 || 120_000,
  })
}
