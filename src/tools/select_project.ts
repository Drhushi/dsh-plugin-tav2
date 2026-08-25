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
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { readRecentProjects, type RecentProjectInfo } from '../engine/config'
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
 * 扫描 dir 的直接子目录里含 config.yaml 的项目配置目录（工作区简洁：上级文件夹兼容）。
 * 目录不可读/不存在一律静默返回空，回退游戏目录语义。
 */
export function discoverProjectsUnder(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const candidate = join(dir, e.name)
      if (existsSync(join(candidate, 'config.yaml'))) out.push(candidate)
    }
    return out
  } catch {
    return []
  }
}

/** 解析当前会话应使用的 projectDir（外部工具可复用）。 */
export function resolveProjectDir(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionProjectDirs.has(sessionKey)) return sessionProjectDirs.get(sessionKey)!
  return config.projectDir
}

/** 解析当前会话应使用的 gameDir 覆盖（外部工具可复用）。 */
export function resolveGameDir(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionGameDirs.has(sessionKey)) return sessionGameDirs.get(sessionKey)!
  return config.gameDirOverride ?? ''
}

/**
 * 解析会话生效的目标语言：会话覆盖（/tav2-lang 写入）→ 配置 langOverride →
 * 引擎默认 chinese。工具层经 loadEngineConfigFor 统一套用到 engineCfg.lang。
 */
export function resolveLang(config: Config, sessionKey?: string): string {
  if (sessionKey && sessionLangOverrides.has(sessionKey)) return sessionLangOverrides.get(sessionKey)!
  return (config.langOverride ?? '').trim() || 'chinese'
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
  const isConfigDir = existsSync(join(target, 'config.yaml'))
  if (isConfigDir) {
    config.projectDir = target
    config.engineConfigPath = ''
    config.gameDirOverride = undefined
    sessionProjectDirs.set(sessionKey, target)
    sessionGameDirs.delete(sessionKey)
    sessionWorkspaceProjects.delete(sessionKey)
    return { kind: 'config-dir', dir: target }
  }
  const found = discoverProjectsUnder(target)
  if (found.length === 1) {
    const dir = found[0]!
    config.projectDir = dir
    config.engineConfigPath = ''
    config.gameDirOverride = undefined
    sessionProjectDirs.set(sessionKey, dir)
    sessionGameDirs.delete(sessionKey)
    sessionWorkspaceProjects.delete(sessionKey)
    return { kind: 'config-dir', dir }
  }
  if (found.length > 1) {
    sessionWorkspaceProjects.set(sessionKey, found)
    return { kind: 'multiple', candidates: found }
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
  } else {
    resolved = matched?.path ?? target
    // 保持当前配置目录不变，只覆盖 engine.game_dir。
    sessionProjectDirs.set(sessionKey, config.projectDir)
    sessionGameDirs.set(sessionKey, resolved)
    config.gameDirOverride = resolved
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
