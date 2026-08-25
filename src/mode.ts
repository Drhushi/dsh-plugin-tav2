/**
 * 翻译模式状态与命令：插件自有状态文件 + tav2-mode 命令 + settings namespace 桥。
 *
 * - 状态持久化在插件自有状态文件 `~/.dsh/dsh-plugin-tav2/state.json`
 *   （`{ mode, projects, translationApi?, renpySdk? }`），不依赖 harness 配置热更新。
 * - projects 记录各游戏目录的引擎识别结果（key=游戏目录绝对路径），
 *   会话恢复后直接读取，不再依赖“新建会话现场探测”。
 * - 自动识别语义（去开关后）：翻译工具安装不再由开关控制——游戏工作区的新会话
 *   自动装全套，普通工作区自动装轻量引导包；/tav2-mode on 仅保留「把当前会话升级为
 *   全套」的兼容 rearm，off 为兼容空操作。state.json 的 mode 字段保留但不再作为门控。
 * - settings namespace 桥：设置卡写翻译渠道（→ state.json.translationApi）与
 *   Ren'Py SDK 路径（→ state.json.renpySdk），服务端启动时反同步进 state.json。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TranslationApiConfig, TranslationScope } from './config'

/** 插件状态文件相对 dsh home 的路径。 */
export const MODE_STATE_REL = join('dsh-plugin-tav2', 'state.json')

/** 设置 UI 使用的 namespace 名（与插件宿主行 id=tav2 一致）。 */
export const MODE_SETTINGS_NS = 'tav2'

/** 某游戏目录的引擎识别记录（落盘到 state.json.projects）。 */
export interface ProjectEngineInfo {
  engine: string
  detectedAt: string
}

/** 插件自有状态文件的完整结构。 */
export interface PluginState {
  mode: boolean
  projects: Record<string, ProjectEngineInfo>
  /** 设置卡（界面）写入的翻译专用 API 字段（仅含用户层；密钥不落盘）。 */
  translationApi?: TranslationApiConfig
  /** 设置卡（界面）写入的 Ren'Py SDK 路径（覆盖 yaml 配置层）。 */
  renpySdk?: string
}

/** /tav2-mode status 可读的翻译作用域注册结果投影（由 translation_scope 提供）。 */
export interface RegistrationInfoLike {
  ok: boolean
  installed: boolean
  reason?: string
  error?: string
  cwd?: string
  engine?: string
  configYaml: boolean
  /** 作用域等级：full=全套（游戏工作区）；slim=轻量引导包（普通工作区）。 */
  kind?: 'full' | 'slim'
  /** 工作区含多个项目时的候选列表（reason='workspace-multiple'）。 */
  candidates?: string[]
  at: string
}

/** 解析 dsh home（DSH_HOME 优先，缺省 ~/.dsh）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME
  if (explicit && explicit.trim()) return explicit.trim()
  return join(homedir(), '.dsh')
}

/** 状态文件绝对路径（测试可传自定义 dshHome）。 */
export function modeStatePath(dshHomeDir?: string): string {
  return join(dshHomeDir ?? dshHome(), MODE_STATE_REL)
}

/** 读取完整状态：文件缺失或损坏一律 fail-closed（mode=off，projects 空）。 */
export function readState(statePath: string): PluginState {
  try {
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw) as { mode?: unknown; projects?: unknown }
      & { translationApi?: unknown; renpySdk?: unknown }
    const projects: Record<string, ProjectEngineInfo> = {}
    if (parsed && typeof parsed.projects === 'object' && parsed.projects !== null) {
      for (const [key, value] of Object.entries(parsed.projects as Record<string, unknown>)) {
        const v = value as Partial<ProjectEngineInfo> | undefined
        if (v && typeof v.engine === 'string') {
          projects[key] = {
            engine: v.engine,
            detectedAt: typeof v.detectedAt === 'string' ? v.detectedAt : '',
          }
        }
      }
    }
    return {
      mode: parsed?.mode === true,
      projects,
      translationApi: parseStateApi(parsed?.translationApi),
      renpySdk: typeof parsed?.renpySdk === 'string' && parsed.renpySdk.trim() ? parsed.renpySdk : undefined,
    }
  } catch {
    return { mode: false, projects: {}, translationApi: undefined, renpySdk: undefined }
  }
}

/** 写入完整状态（先建目录再写文件；失败抛错由调用方处理）。 */
export function writeState(statePath: string, state: PluginState): void {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/** 读取模式：文件缺失或损坏一律视为关（fail-closed，翻译功能零侵入）。 */
export function readMode(statePath: string): boolean {
  return readState(statePath).mode
}

/** 自动识别开关：默认关（fail-closed，与 readMode/readState 一致）；仅显式 mode=true 才开。 */
export function readAutoDetect(statePath: string): boolean {
  try {
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw) as { mode?: unknown }
    return parsed?.mode === true
  } catch {
    return false
  }
}

/** 写入模式（保留既有 projects 记录，避免覆盖引擎识别结果）。 */
export function writeMode(statePath: string, mode: boolean): void {
  writeState(statePath, { ...readState(statePath), mode })
}

/** 从任意输入窄化出合法翻译专用 API 字段（scope 非法则丢弃；密钥值一律不接收）。 */
export function parseStateApi(value: unknown): TranslationApiConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const SCOPES: TranslationScope[] = ['main', 'all', 'experimental']
  const out: TranslationApiConfig = {}
  if (typeof v.baseUrl === 'string') out.baseUrl = v.baseUrl
  if (typeof v.model === 'string') out.model = v.model
  if (typeof v.apiKeyEnv === 'string') out.apiKeyEnv = v.apiKeyEnv
  if (typeof v.scope === 'string' && SCOPES.includes(v.scope as TranslationScope)) {
    out.scope = v.scope as TranslationScope
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 读取 state.json 里界面写入的翻译专用 API 字段（无则 undefined）。 */
export function readStateApi(statePath: string): TranslationApiConfig | undefined {
  return readState(statePath).translationApi
}

/** 写入 state.json 的翻译专用 API 字段（undefined=清空，重新继承 yaml 层）。 */
export function writeStateApi(statePath: string, api: TranslationApiConfig | undefined): void {
  writeState(statePath, { ...readState(statePath), translationApi: api })
}

/** 读取设置卡写入的 Ren'Py SDK 路径（无则 undefined，回退 yaml 层 config.renpySdk）。 */
export function readStateRenpySdk(statePath: string): string | undefined {
  return readState(statePath).renpySdk
}

/** 写入设置卡填写的 Ren'Py SDK 路径（undefined/空=清空，回退 yaml 层）。 */
export function writeStateRenpySdk(statePath: string, sdk: string | undefined): void {
  const value = (sdk ?? '').trim()
  writeState(statePath, { ...readState(statePath), renpySdk: value || undefined })
}

/** 读取某游戏目录已落盘的引擎（无记录返回 undefined）。 */
export function getProjectEngine(statePath: string, gameDir: string): string | undefined {
  return readState(statePath).projects[gameDir]?.engine
}

/** 记录某游戏目录的引擎识别结果（幂等写入）。 */
export function setProjectEngine(statePath: string, gameDir: string, engine: string, detectedAt: string): void {
  const state = readState(statePath)
  state.projects[gameDir] = { engine, detectedAt }
  writeState(statePath, state)
}

/** tav2-mode 命令 / settings 桥共用的最小结果类型（避免依赖 dsh-commands 类型）。 */
export interface ModeCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** 解析 tav2-mode 原始输入（含前导空白）。 */
export function parseModeCommand(rawInput: string): 'on' | 'off' | 'status' | undefined {
  const token = rawInput.trim().toLowerCase()
  if (token === 'on' || token === 'off' || token === 'status') return token
  return undefined
}

/** 执行 tav2-mode <on|off|status>；可注入 settings 写入器做双向同步。 */
export function handleModeCommand(
  statePath: string,
  rawInput: string,
  _syncSettings?: (mode: boolean) => void,
  agentId?: string,
  registration?: (agentId: string) => RegistrationInfoLike | undefined,
  rearm?: (agentId: string) => ModeCommandResult | undefined,
  /** 当前翻译通道描述（专用 API baseUrl/model 或 宿主 provider），供 status 展示。 */
  channel?: () => string,
  /** 当前加载的插件版本/来源描述，供 status 自检（区分新旧 build）。 */
  describePlugin?: () => string,
): ModeCommandResult {
  const action = parseModeCommand(rawInput)
  if (action === undefined) {
    return {
      kind: 'error',
      text: '用法：/tav2-mode status（查看状态）| on（立即把当前会话升级为全套翻译工具）',
    }
  }
  try {
    if (action === 'status') {
      const lines = [
        '翻译工具安装：游戏工作区自动装全套，普通工作区自动装引导包（tav2_detect/tav2_init/'
          + 'tav2_select_project/tav2_status）——无需手动开关。',
      ]
      const channelText = channel?.()
      if (channelText) lines.push(channelText)
      const pluginText = describePlugin?.()
      if (pluginText) lines.push(pluginText)
      if (agentId) {
        const reg = registration?.(agentId)
        if (reg) {
          if (reg.ok && reg.installed) {
            if (reg.kind === 'slim') {
              lines.push('本会话翻译作用域：轻量引导包——说「初始化游戏翻译」即可开始。')
            } else {
              lines.push(`本会话翻译作用域：已安装全套${reg.engine ? `，引擎=${reg.engine}` : ''}`)
            }
          } else if (!reg.ok) {
            lines.push(`本会话翻译作用域：安装失败（${reg.error ?? '未知原因'}）`)
          } else if (reg.reason === 'workspace-multiple') {
            lines.push('本会话翻译作用域：已安装全套，但工作区下发现多个项目，当前用默认项目')
          } else {
            lines.push('本会话翻译作用域：未安装')
          }
          const engineNote = !reg.configYaml && reg.engine ? `（引擎=${reg.engine}）` : ''
          lines.push(`工作区 config.yaml：${reg.configYaml ? '存在' : '不存在'}${engineNote}`)
          if (reg.candidates && reg.candidates.length > 0) {
            lines.push(`发现 ${reg.candidates.length} 个项目候选：`)
            for (const c of reg.candidates) lines.push(`  - ${c}`)
            lines.push('提示：用 tav2_select_project <绝对路径> 选择后即可切换。')
          }
          if (reg.kind === 'slim') {
            lines.push('提示：输入 /tav2-mode on 可立即把当前会话升级为全套翻译工具。')
          }
        } else {
          lines.push('本会话翻译作用域：无记录（可能是恢复会话）——说「初始化游戏翻译」或输入 /tav2-mode on。')
        }
      }
      return {
        kind: 'success',
        text: lines.join('\n'),
      }
    }
    // on/off 已无开关语义（自动安装默认开启）：on 仍可把当前会话升级为全套，off 为兼容空操作。
    const texts = action === 'on'
      ? ['翻译工具已随工作区自动安装，无需手动开启。', '/tav2-mode on 仍可把当前会话强制升级为全套翻译工具。']
      : ['自动安装已默认开启，无需关闭（/tav2-mode off 为兼容空操作）。']
    if (action === 'on' && agentId) {
      const rearmed = rearm?.(agentId)
      if (rearmed) texts.push(rearmed.text)
    }
    return {
      kind: 'success',
      text: texts.join('\n'),
    }
  } catch (err) {
    return {
      kind: 'error',
      text: `切换失败：${String(err instanceof Error ? err.message : err)}`,
    }
  }
}
