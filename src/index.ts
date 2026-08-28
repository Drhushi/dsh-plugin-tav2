import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config } from './config'
import { handleModeCommand, MODE_SETTINGS_NS, modeStatePath, readStateApi, writeStateApi, writeStateRenpySdk } from './mode'
import { tav2SettingsSchema, resolveChannelApi } from './tav2Settings'
import { describeChannelSync, mergeTranslationApi } from './tools/translationApi'
import { applyTranslationScope, handleLangCommand, recordRegistration, registrationOf } from './translation_scope'
// 注意：./tools/panel 必须在 ./translation_scope 之后 import——panel → select_project →
// translation_scope → tools/index 存在既有导入环；若 panel 先于 translation_scope 求值，
// tools/index 会在 select_project 求值中途构建 TOOL_REGISTRY，导致 tav2_select_project 注册缺失。
import { registerPanelRoute } from './tools/panel'
import { registerPanelCommand } from './tools/panel_commands'
import { pluginSource, pluginVersion } from './version'

export const name = 'dsh-plugin-tav2'

// 声明依赖让 cordis 在 apply 前把这些服务准备好：settings（设置卡读写通道）与
// commands（tav2-mode 命令）都是宿主 base 行，web profile 必然提供。
export const inject = ['settings', 'commands']

export { Config }
export type { Config as PluginConfig }

/** settings namespace 的最小服务面（不依赖 dsh-settings 宿主类型）。 */
interface SettingsLike {
  register?(ns: string, schema: unknown, options?: { applies?: string; base?: unknown }): unknown
  update?(ns: string, patch: Record<string, unknown>): Promise<unknown>
  describe?(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    user?: Record<string, unknown>
    value?: Record<string, unknown>
  }>
}

/** tav2-mode 命令的最小服务面（不依赖 dsh-commands 宿主类型）。 */
interface CommandsLike {
  register?(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { rawInput: string; signal: AbortSignal; agent: { id: unknown } }) =>
      | { kind: 'success' | 'error'; text: string }
      | Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

export function apply(ctx: Context, config: Config): void {
  const statePath = modeStatePath()
  const settings = ctx.get('settings') as SettingsLike | undefined
  const commands = ctx.get('commands') as CommandsLike | undefined

  // 1) settings namespace：设置卡（client）读/写翻译渠道（列表/当前渠道）+ Ren'Py SDK 路径。
  //    connection.api 没有 command RPC（命令必须带 sessionId），settings 域是
  //    最接近的既有通道；服务端把「当前渠道」映射成 state.json 的 translationApi、
  //    renpySdk 映射成 state.json 的 renpySdk。
  let nsRegistered = false
  try {
    if (settings?.register) {
      settings.register(MODE_SETTINGS_NS, tav2SettingsSchema, { applies: 'live' })
      nsRegistered = true
    }
  } catch (err) {
    console.warn('[dsh-plugin-tav2] settings namespace 注册失败：', err)
  }
  // 把「当前渠道」映射成 state.json 的 translationApi（引擎消费；密钥引用名自动生成）。
  const syncActiveChannel = (next: unknown): void => {
    try {
      const v = (next && typeof next === 'object')
        ? next as { translationChannels?: unknown; translationActiveChannel?: unknown }
        : {}
      writeStateApi(statePath, resolveChannelApi(v.translationChannels, v.translationActiveChannel))
    } catch (err) {
      console.warn('[dsh-plugin-tav2] 翻译渠道→state.json 同步失败：', err)
    }
  }
  // 把设置卡填写的 Ren'Py SDK 路径映射成 state.json 的 renpySdk（覆盖 yaml 配置层）。
  const syncRenpySdk = (next: unknown): void => {
    try {
      const v = (next && typeof next === 'object') ? next as { renpySdk?: unknown } : {}
      const sdk = typeof v.renpySdk === 'string' ? v.renpySdk : undefined
      writeStateRenpySdk(statePath, sdk)
    } catch (err) {
      console.warn('[dsh-plugin-tav2] renpySdk→state.json 同步失败：', err)
    }
  }
  ;(ctx as unknown as { on?: (event: string, listener: (...args: unknown[]) => void) => unknown })
    .on?.('settings/updated', (ns: unknown, next: unknown) => {
      if (ns === MODE_SETTINGS_NS) {
        syncActiveChannel(next)
        syncRenpySdk(next)
      }
    })
  // 启动时把 settings 文档里的当前渠道与 renpySdk 同步进 state.json（覆盖直接改 settings.yaml 的情况）。
  try {
    const desc = settings?.describe?.({ redactSecrets: true })
    const ns = desc?.find((d) => d.ns === MODE_SETTINGS_NS)
    syncActiveChannel(ns?.value)
    syncRenpySdk(ns?.value)
  } catch (err) {
    console.warn('[dsh-plugin-tav2] 启动设置同步失败：', err)
  }

  // 2) tav2-mode 命令：任意会话可用，测试直接调 handleModeCommand。
  //    会话内 rearm：on 时对当前会话强制升级为全套（恢复/漏装的会话即时补回）。
  const agentsSvc = (ctx as unknown as { get?: (name: string) => unknown }).get?.('agents') as
    | { get?: (id: unknown) => Agent | undefined }
    | undefined
  const rearmFor = (agent: { id: unknown }) => {
    const full = (agent as { ctx?: unknown }).ctx ? (agent as Agent) : agentsSvc?.get?.(agent.id)
    if (!full) {
      return {
        kind: 'error' as const,
        text: '无法取得当前会话的 agent 上下文，安装失败（宿主命令未传入完整 agent，且 agents 服务不可用）。',
      }
    }
    try {
      applyTranslationScope(full, config, statePath, { force: true })
      return { kind: 'success' as const, text: '已为当前会话升级为全套翻译工具，下一条消息即可使用全部 tav2_* 工具。' }
    } catch (err) {
      return { kind: 'error' as const, text: `安装失败：${String(err instanceof Error ? err.message : err)}` }
    }
  }
  try {
    commands?.register?.({
      name: 'tav2-mode',
      description: '翻译工具状态：/tav2-mode status（查看状态）| on（把当前会话立即升级为全套翻译工具）',
      input: { hint: 'status|on' },
      handler: ({ agent, rawInput }) => handleModeCommand(
        statePath, rawInput, undefined, String(agent.id), registrationOf, () => rearmFor(agent),
        () => describeChannelSync({ ...config, translationApi: mergeTranslationApi(config.translationApi, readStateApi(statePath)) }),
        () => `插件：v${pluginVersion()}（${pluginSource()}）`,
      ),
    })
  } catch (err) {
    console.warn('[dsh-plugin-tav2] tav2-mode 命令注册失败：', err)
  }

  // 2b) tav2-lang 命令：会话级目标语言切换（生产端入口，不改 dsh 设置卡）。
  try {
    commands?.register?.({
      name: 'tav2-lang',
      description: '切换本会话翻译目标语言：/tav2-lang status|chinese|english|zh-CN|en-US …',
      input: { hint: 'status|<lang>' },
      handler: ({ agent, rawInput }) => handleLangCommand(String(agent.id), rawInput, config),
    })
  } catch (err) {
    console.warn('[dsh-plugin-tav2] tav2-lang 命令注册失败：', err)
  }

  console.log(
    `[dsh-plugin-tav2] 设置卡通道：settings=${settings ? 'ok' : 'missing'}`
    + ` ns=${nsRegistered ? 'registered' : 'skipped'} commands=${commands ? 'ok' : 'missing'}`,
  )

  // 2c) 翻译工作台：/tav2/panel 只读路由（会话级「翻译」标签页数据源）+ /tav2-panel 命令
  //     （面板交互按钮 → 确定性执行对应 tav2_* 工具，写操作审批由工具自带）。
  //     webServer / commands 缺失（如非 web profile）时内部告警跳过，不阻塞。
  try {
    registerPanelRoute(ctx)
  } catch (err) {
    console.warn('[dsh-plugin-tav2] /tav2/panel 路由注册失败：', err)
  }
  try {
    registerPanelCommand(ctx)
  } catch (err) {
    console.warn('[dsh-plugin-tav2] /tav2-panel 命令注册失败：', err)
  }

  // 3) agent/created：一律按工作区自动安装翻译作用域（游戏区全套 / 普通区轻量引导）。
  //    不再依赖自动识别开关——开关已移除，无需用户输入 /tav2-mode on。
  ctx.on('agent/created', ({ agent }) => {
    const agentId = String(agent.id)
    try {
      applyTranslationScope(agent, config, statePath)
    } catch (err) {
      console.warn('[dsh-plugin-tav2] 翻译作用域注册失败：', err)
      recordRegistration({
        agentId,
        ok: false,
        installed: false,
        reason: 'error',
        error: String(err instanceof Error ? err.message : err),
        cwd: agent.session?.header?.cwd,
        configYaml: false,
        at: new Date().toISOString(),
      })
    }
  })

  console.log(
    `[dsh-plugin-tav2] 已加载，翻译作用域按工作区自动安装（游戏区全套/普通区引导）`
    + ` projectDir=${config.projectDir || '（当前目录）'}`
    + ` engineBackend=${config.engineBackend} approval=${config.approval}`
    + ` subagentMaxWorkers=${config.subagentMaxWorkers ?? 2}`,
  )
}
