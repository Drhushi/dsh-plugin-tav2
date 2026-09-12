/**
 * tav2kit config 子命令：读/写项目 config.yaml（SPEC-STANDALONE Phase 2 首批）。
 * - config get：只读展示 engine/game_dir/lang 与翻译渠道（translationApi 段）。
 * - config set <key> <value>：写白名单字段（lang 顶层 / translationApi.* 渠道字段），
 *   其余 key 一律 fail-closed 拒绝——防止 agent 误改 engine/game_dir 破坏项目。
 * 渠道 env 化：translationApi.apiKeyEnv 指定密钥环境变量名（如 TRANSLATE_API_KEY），
 * 密钥值永不落盘，只从环境变量读取（LLM 直连收口配套）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Tav2ToolResult } from '../core/types'

/** 顶层允许直接写的字段（白名单；engine/game_dir 不允许改）。 */
const TOP_ALLOWED = new Set(['lang'])

/** translationApi 段允许写的字段（渠道 env 化配置面）。 */
const API_ALLOWED = new Set(['baseUrl', 'model', 'scope', 'apiKeyEnv'])

function notFound(configPath: string): Tav2ToolResult {
  return { ok: false, command: 'config', text: `未找到项目 config.yaml（${configPath}）。`, timedOut: false }
}

function toResult(configPath: string, text: string, ok = true): Tav2ToolResult {
  return { ok, command: 'config', text, timedOut: false }
}

/** 读取原始 yaml 对象（不存在/解析失败返回 null）。CLI 侧 LLM 直连复用（读 translationApi 渠道）。 */
export function loadRaw(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null
  try {
    const raw = yaml.load(readFileSync(configPath, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

/** 只读展示：engine / game_dir / lang + 翻译渠道。 */
export function readConfigSummary(projectDir: string): Tav2ToolResult {
  const configPath = join(projectDir, 'config.yaml')
  const raw = loadRaw(configPath)
  if (raw === null) return notFound(configPath)
  const str = (k: string): string => (typeof raw[k] === 'string' ? String(raw[k]) : '')
  const api = raw.translationApi as Record<string, unknown> | undefined
  const lines = [
    `config.yaml: ${configPath}`,
    `engine: ${str('engine') || '（未配置）'}`,
    `game_dir: ${str('game_dir') || '（未配置）'}`,
    `lang: ${str('lang') || 'chinese'}`,
  ]
  if (api && typeof api === 'object') {
    const apiStr = (k: string): string => (typeof api[k] === 'string' ? String(api[k]) : '')
    const baseUrl = apiStr('baseUrl')
    if (baseUrl) {
      lines.push(
        `translationApi.baseUrl: ${baseUrl}`,
        `translationApi.model: ${apiStr('model') || '（沿用 llm.model）'}`,
        `translationApi.scope: ${apiStr('scope') || 'main'}`,
        `translationApi.apiKeyEnv: ${apiStr('apiKeyEnv') || 'TRANSLATE_API_KEY'}`,
      )
    } else {
      lines.push('翻译渠道：未配置（doctor 可检查就绪度；LLM 直连需配 baseUrl）')
    }
  } else {
    lines.push('翻译渠道：未配置（doctor 可检查就绪度；LLM 直连需配 baseUrl）')
  }
  lines.push('设置：tav2kit config set lang <值> / config set translationApi.baseUrl <url> 等')
  return toResult(configPath, lines.join('\n'))
}

/** 校验 key 是否可写；返回统一的中文拒绝说明（fail-closed）。 */
export function configSetPreview(configPath: string, key: string, value: string): Tav2ToolResult | null {
  const apiField = key.startsWith('translationApi.')
  if (apiField) {
    const field = key.slice('translationApi.'.length)
    if (!API_ALLOWED.has(field)) {
      return toResult(configPath, `config set 拒绝 key「${key}」：translationApi 只允许 ${[...API_ALLOWED].join(' / ')}。`, false)
    }
  } else if (!TOP_ALLOWED.has(key)) {
    return toResult(
      configPath,
      `config set 拒绝 key「${key}」：只允许 lang 与 translationApi.*；engine/game_dir 等请直接编辑 config.yaml（改错会破坏项目）。`,
      false,
    )
  }
  return null
}

/** 写回 config.yaml（key 白名单已在调用方校验；失败返回 ok=false 不写盘）。 */
export function writeConfigValue(configPath: string, key: string, value: string): Tav2ToolResult {
  if (!existsSync(configPath)) return notFound(configPath)
  const raw = loadRaw(configPath)
  if (raw === null) {
    return toResult(configPath, `config.yaml 解析失败（${configPath}），未修改。`, false)
  }
  const apiField = key.startsWith('translationApi.')
  if (apiField) {
    const field = key.slice('translationApi.'.length)
    const prev = (raw.translationApi && typeof raw.translationApi === 'object'
      ? raw.translationApi
      : {}) as Record<string, unknown>
    raw.translationApi = { ...prev, [field]: value }
  } else {
    raw[key] = value
  }
  try {
    writeFileSync(configPath, yaml.dump(raw), 'utf8')
    return toResult(configPath, `已更新 ${configPath}：\n  ${key}: ${value}`)
  } catch (err) {
    return toResult(configPath, `写入失败：${String(err instanceof Error ? err.message : err)}`, false)
  }
}
