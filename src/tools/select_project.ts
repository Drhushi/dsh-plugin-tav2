/**
 * tav2_select_project：M6 多项目切换。
 *
 * 两种切换语义：
 * - 目标是含 config.yaml 的配置目录：切 projectDir（读另一份配置）。
 * - 目标是 recent_projects 中的项目名/游戏目录（或直接给游戏目录）：
 *   保持当前配置目录不变，仅设置 gameDirOverride 覆盖 engine.game_dir。
 * 会话级覆盖以 agent 的 sessionId 为键，挂 agent/disposed 清理；切换后跑
 * tav2_status 验证新项目可读。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { readRecentProjects, loadEngineConfig, resolveConfigPath, type RecentProjectInfo } from '../engine/config'
import { discoverConfigProjects } from '../engine/discover'
import type { Tav2ToolResult } from '../core/types'
import { runTsStatus, type Tav2StatusSummary, tav2StatusJsonSchema } from './status'
import { modeStatePath } from '../mode'
import { upgradeAgentScopeToFull } from '../translation_scope'

const sessionProjectDirs = new Map<string, string>()
const sessionGameDirs = new Map<string, string>()
const sessionLangOverrides = new Map<string, string>()
/** 工作区=上级文件夹时发现的多候选项目（按会话记录，供 tav2_select_project list 列出）。 */
const sessionWorkspaceProjects = new Map<string, string[]>()

/** applyWorkspaceCwd 的解析结果（供调用方记录候选/注册信息）。 */
export type WorkspaceApplyResult =
  | { kind: 'config-dir'; dir: string }
  | { kind: 'game-dir'; dir: string }
  | { kind: 'multiple'; candidates: string[] }
  | { kind: 'none' }

/**
 * 扫描 dir 的直接子目录里含 config.yaml 的项目配置目录（兼容旧语义：仅一层）。
 * 深层发现（母文件夹多游戏）走共享 util discoverConfigProjects（有界递归）。
 * 目录不可读/不存在一律静默返回空，回退游戏目录语义。
 */
export function discoverProjectsUnder(dir: string): string[] {
  return discoverConfigProjects(dir, { maxDepth: 1 })
    .filter((p) => p.depth > 0)
    .map((p) => p.dir)
}

/** 解析当前会话应使用的 projectDir（外部工具可复用）。 */
export function resolveProjectDir(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionProjectDirs.has(sessionKey)) return sessionProjectDirs.get(sessionKey)!
  return config.projectDir
}

/** 仅读会话级项目选择（无则 undefined，不回退默认 projectDir）。面板路由据此跟随会话。 */
export function sessionProjectOverride(sessionKey: string): string | undefined {
  return sessionProjectDirs.get(sessionKey)
}

/**
 * 仅读会话级游戏目录覆盖（无则 undefined，不回退 config.gameDirOverride）。
 * select_project 的「游戏目录」语义（如编译版 _prep 暂存项目）走这里；
 * 面板路由据此把 DB 路径与 tl 提取对齐到会话真正绑定的游戏目录。
 */
export function sessionGameOverride(sessionKey: string): string | undefined {
  return sessionGameDirs.get(sessionKey)
}

/** 解析当前会话应使用的 gameDir 覆盖（外部工具可复用）。 */
export function resolveGameDir(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionGameDirs.has(sessionKey)) return sessionGameDirs.get(sessionKey)!
  return config.gameDirOverride ?? ''
}

/**
 * 解析会话生效的目标语言：会话覆盖（/tav2-lang 写入）→ 配置 langOverride →
 * config.yaml 的 lang（与面板/引擎口径一致）→ 引擎默认 chinese。
 * 工具层经 loadEngineConfigFor 统一套用到 engineCfg.lang，与面板直读 config.yaml 对齐。
 */
export function resolveLang(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionLangOverrides.has(sessionKey)) return sessionLangOverrides.get(sessionKey)!
  const override = (config.langOverride ?? '').trim()
  if (override) return override
  try {
    const lang = loadEngineConfig(config.engineConfigPath, config.projectDir).lang.trim()
    if (lang) return lang
  } catch {
    // 无 config.yaml / 解析失败 → 回退默认
  }
  return 'chinese'
}

/** 设置某会话的目标语言覆盖（/tav2-lang 命令入口）。 */
export function setSessionLangOverride(sessionKey: string, lang: string): void {
  const value = (lang ?? '').trim()
  if (!value) {
    sessionLangOverrides.delete(sessionKey)
    return
  }
  sessionLangOverrides.set(sessionKey, value)
}

/** 删除某会话的项目/游戏覆盖（agent/disposed 清理入口，测试可直调）。 */
export function clearSessionOverride(sessionKey: string): void {
  sessionProjectDirs.delete(sessionKey)
  sessionGameDirs.delete(sessionKey)
  sessionLangOverrides.delete(sessionKey)
  sessionWorkspaceProjects.delete(sessionKey)
}

/** 清理全部覆盖（测试/诊断用）。 */
export function clearAllSessionOverrides(): void {
  sessionProjectDirs.clear()
  sessionGameDirs.clear()
  sessionLangOverrides.clear()
  sessionWorkspaceProjects.clear()
}

/**
 * 把工作区 cwd 作为会话级项目覆盖写入（工作区=游戏目录语义）：
 * - cwd 含 config.yaml → 视为配置目录覆盖 projectDir；
 * - cwd 是上级文件夹：其直接子目录含唯一 config.yaml 项目 → 自动当配置目录；
 *   含多个 → 记录候选（kind='multiple'，供 tav2_select_project list 列出选择）；
 * - 否则 → 视为游戏目录覆盖 gameDir（保持配置目录不变）。
 */
export function applyWorkspaceCwd(config: Config, sessionKey: string, cwd: string): WorkspaceApplyResult {
  const target = (cwd ?? '').trim()
  if (!target) return { kind: 'none' }
  // 有界递归（含根自身 depth 0）发现工作区下所有 config.yaml 项目（母文件夹深层兼容）。
  const found = discoverConfigProjects(target)
  const rootHit = found.find((p) => p.depth === 0)
  if (rootHit) {
    config.projectDir = rootHit.dir
    config.engineConfigPath = ''
    config.gameDirOverride = undefined
    sessionProjectDirs.set(sessionKey, rootHit.dir)
    sessionGameDirs.delete(sessionKey)
    sessionWorkspaceProjects.delete(sessionKey)
    return { kind: 'config-dir', dir: rootHit.dir }
  }
  const subs = found.filter((p) => p.depth > 0)
  if (subs.length === 1) {
    const dir = subs[0]!.dir
    config.projectDir = dir
    config.engineConfigPath = ''
    config.gameDirOverride = undefined
    sessionProjectDirs.set(sessionKey, dir)
    sessionGameDirs.delete(sessionKey)
    sessionWorkspaceProjects.delete(sessionKey)
    return { kind: 'config-dir', dir }
  }
  if (subs.length > 1) {
    const candidates = subs.map((p) => p.dir)
    sessionWorkspaceProjects.set(sessionKey, candidates)
    return { kind: 'multiple', candidates }
  }
  sessionProjectDirs.set(sessionKey, config.projectDir)
  sessionGameDirs.set(sessionKey, target)
  config.gameDirOverride = target
  return { kind: 'game-dir', dir: target }
}

/** 工具执行时的会话键：优先 agent 的 sessionId（跨轮稳定），缺失时回退 rootCallId。 */
export function sessionKeyOf(exec: { agent?: { id: unknown } | null; rootCallId: string }): string {
  return exec.agent?.id ? String(exec.agent.id) : exec.rootCallId
}

/**
 * 把顶层 `game_dir_override` 写回 config.yaml（文本级替换，保留其它内容与注释）。
 * 空值 = 删除该键（清除覆盖）。路径统一正斜杠，避免 YAML 纯量歧义。
 * 这是 select_project「游戏目录」语义的持久化：进程重启后面板/工具链仍指向同一目标。
 */
export function updateConfigGameDirOverride(configPath: string, value: string): void {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return // config.yaml 不可读时静默跳过（内存覆盖仍然生效）
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const idx = lines.findIndex((l) => /^\s*game_dir_override:/.test(l))
  if (!value.trim()) {
    if (idx === -1) return
    lines.splice(idx, 1)
  } else if (idx >= 0) {
    lines[idx] = `game_dir_override: ${value.trim().replace(/\\/g, '/')}`
  } else {
    const sep = text.endsWith('\n') || text === '' ? '' : '\n'
    writeFileSync(configPath, `${text}${sep}game_dir_override: ${value.trim().replace(/\\/g, '/')}\n`, 'utf8')
    return
  }
  writeFileSync(configPath, lines.join('\n'), 'utf8')
}

export function runTsSelectProject(
  config: Config,
  project: string,
  sessionKey: string,
): Tav2ToolResult & { switchedTo?: string; recent?: RecentProjectInfo[]; status?: Tav2StatusSummary } {
  let target = project.trim()
  const recent = readRecentProjects(config.engineConfigPath, config.projectDir)
  // 列出/空目标：工作区多候选时列出让用户选；唯一候选自动切换。
  if (target === 'list' || target === '?' || target === '') {
    const candidates = sessionWorkspaceProjects.get(sessionKey) ?? []
    if (candidates.length === 1) {
      target = candidates[0]!
    } else if (candidates.length > 1) {
      const recentText = recent.length
        ? recent.map((r) => `  - ${r.name} -> ${r.path}`).join('\n')
        : '（无 recent_projects）'
      return {
        ok: false,
        command: 'select_project list',
        text: `工作区下发现 ${candidates.length} 个项目，请用 tav2_select_project <绝对路径> 选择：\n`
          + candidates.map((c) => `  - ${c}`).join('\n')
          + `\n或 recent_projects：\n${recentText}`,
        timedOut: false,
        switchedTo: '',
        recent,
      }
    }
  }
  const matched = recent.find((r) => r.name === target || r.path === target)
  const allowed = matched !== undefined || existsSync(target)
  if (!allowed) {
    const display = recent.map((r) => `${r.name} -> ${r.path}`).join('、') || '（空）'
    return {
      ok: false,
      command: `select_project ${target}`,
      text: `项目不在 recent_projects 中且路径不存在：${target}
当前可切换：${display}`,
      timedOut: false,
      switchedTo: '',
      recent,
    }
  }

  // 目录里带 config.yaml：切换的是“配置目录”；否则切换的是“游戏目录”。
  const isConfigDir = existsSync(join(target, 'config.yaml'))
  let resolved = target
  if (isConfigDir) {
    config.projectDir = target
    config.engineConfigPath = ''
    config.gameDirOverride = undefined
    sessionProjectDirs.set(sessionKey, target)
    sessionGameDirs.delete(sessionKey)
    sessionWorkspaceProjects.delete(sessionKey)
    // 清掉该配置里可能残留的持久化覆盖，否则切回后 yaml 仍会把 game_dir 拉去旧目标。
    updateConfigGameDirOverride(join(target, 'config.yaml'), '')
  } else {
    resolved = matched?.path ?? target
    // 保持当前配置目录不变，只覆盖 engine.game_dir。
    sessionProjectDirs.set(sessionKey, config.projectDir)
    sessionGameDirs.set(sessionKey, resolved)
    config.gameDirOverride = resolved
    // 持久化到 config.yaml：内存覆盖会随进程重启/会话销毁丢失，
    // 丢了的后果是面板与工具链静默退回原项目（工作台看起来「不更新」）。
    updateConfigGameDirOverride(resolveConfigPath(config.engineConfigPath, config.projectDir), resolved)
  }

  const status = runTsStatus(config, modeStatePath())
  return {
    ...status,
    command: `select_project ${target}`,
    text: `已切换到项目：${resolved}
${status.text}`,
    switchedTo: resolved,
    recent,
  }
}
/**
 * 切换项目并在成功后确保当前 agent 作用域为全套（slim → full 增量升级）。
 * select_project 是轻量工具，切换成功后需要全套工具继续翻译工作。
 * 红阶段空壳：仅切换；绿阶段在成功后调用 upgradeAgentScopeToFull。
 */
export function runSelectProjectWithUpgrade(
  exec: { agent?: { id?: unknown; ctx?: Context } | null },
  config: Config,
  project: string,
  sessionKey: string,
): Tav2ToolResult & { switchedTo?: string; recent?: RecentProjectInfo[]; status?: Tav2StatusSummary } {
  const res = runTsSelectProject(config, project, sessionKey)
  if (res.ok) {
    // 切换成功：轻量引导会话升级为全套，继续翻译工作（增量注册，重复调用幂等）。
    try {
      upgradeAgentScopeToFull(exec, config)
    } catch (err) {
      console.warn('[dsh-plugin-tav2] select_project 升级作用域失败：', err)
    }
  }
  return res
}

export function registerSelectProjectTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_select_project',
    description: '切换当前会话的翻译项目（从 config.yaml recent_projects 中选择或直接给绝对路径），切换后自动验证状态。',
    parameters: {
      project: {
        type: 'string',
        required: true,
        description: '目标项目：recent_projects 中的名字、游戏目录，或含 config.yaml 的配置目录',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          switchedTo: { type: 'string' },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          status: tav2StatusJsonSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ToolResult & { switchedTo?: string }) => {
        const head = value.ok ? '项目切换成功' : '项目切换失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      return runSelectProjectWithUpgrade(exec, config, args.project, sessionKeyOf(exec))
    },
  }))

  // M6 生命周期清理：agent 销毁时移除其会话覆盖，防止 Map 泄漏。
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) clearSessionOverride(String(agent.id))
  })
}
