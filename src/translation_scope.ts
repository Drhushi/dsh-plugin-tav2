/**
 * 把翻译作用域注册进单个 agent。
 *
 * 安装模型（去开关后，agent/created 一律调用本函数，按工作区自动分级）：
 * - 游戏工作区（含 config.yaml / 能识别为 Ren'Py）→ 全套（full）：全部 tav2_* 工具
 *   + tav2-renpy-workflow 技能 + 翻译 persona + 子代理并行上限变量。
 * - 普通工作区（识别不出游戏）→ 轻量引导包（slim）：tav2_detect / tav2_init /
 *   tav2_select_project / tav2_status + 引导 persona（提示用户说「初始化游戏翻译」）。
 * - /tav2-mode on 仍可强制把当前会话升级为全套（rearm，兼容旧流程）。
 * - tav2_init 初始化成功后由 init 工具把当前会话从 slim 升级为 full（增量注册）。
 *
 * 升级依赖 src/scope_track 的按 agent 已注册跟踪，避免同名工具重复注册抛错。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import { detectEngine } from './engine/adapters'
import { serviceResolvingContext } from './harness'
import { getProjectEngine, readStateApi, readStateRenpySdk, setProjectEngine } from './mode'
import { registerTranslationAssistantPersona, registerTranslationPersona } from './persona'
import {
  clearScopeTrack,
  hasWorkflowSkill,
  markToolsRegistered,
  markWorkflowSkill,
  missingToolNames,
  scopeKindOf,
  setScopeKind,
  type ScopeKind,
} from './scope_track'
import { registerRenpyWorkflowSkill } from './skills/renpyWorkflow'
import { ALL_TOOL_NAMES, SLIM_TOOL_NAMES, registerTools } from './tools'
import { mergeTranslationApi } from './tools/translationApi'
import { applyWorkspaceCwd, resolveLang, setSessionLangOverride } from './tools/select_project'
import { isTranslationWorker } from './tools/ts_subagents'

/** 各翻译会话生效的插件配置（/tav2-lang 命令通过它让语言切换立即生效）。 */
const agentConfigs = new Map<string, Config>()

/** 单 agent 翻译作用域注册结果（供 /tav2-mode status 展示）。 */
export interface RegistrationInfo {
  agentId: string
  ok: boolean
  installed: boolean
  reason?: string
  error?: string
  cwd?: string
  engine?: string
  configYaml: boolean
  /** 作用域等级：full=全套（游戏工作区）；slim=轻量引导包（普通工作区）。 */
  kind?: ScopeKind
  /** 工作区=上级文件夹时发现的多个候选项目（reason='workspace-multiple' 时非空）。 */
  candidates?: string[]
  at: string
}

/** 最近一次注册结果（按 agent id；失败/跳过也记录，供 status 暴露原因）。 */
const registrations = new Map<string, RegistrationInfo>()

/** 查询某 agent 的翻译作用域注册结果（供 /tav2-mode status）。 */
export function registrationOf(agentId: string): RegistrationInfo | undefined {
  return registrations.get(agentId)
}

/** 记录翻译作用域注册结果（失败/跳过也记录，原因进入 status）。 */
export function recordRegistration(info: RegistrationInfo): void {
  registrations.set(info.agentId, info)
}

/** 测试/诊断：清空会话级注册状态与作用域配置。 */
export function resetTranslationScope(): void {
  registrations.clear()
  agentConfigs.clear()
}

/**
 * 工作区没有 config.yaml 时解析引擎：优先读 state.json 已落盘结果，
 * 未命中才现场探测并写回（幂等）。返回解析到的引擎（无则 undefined）。
 */
function resolveOrDetectEngine(statePath: string, cwd: string, perAgent: Config): string | undefined {
  const cached = getProjectEngine(statePath, cwd)
  if (cached) {
    perAgent.engineOverride = cached
    return cached
  }
  const detected = detectEngine(cwd)
  if (detected.detected && detected.engine !== 'unknown') {
    perAgent.engineOverride = detected.engine
    try {
      setProjectEngine(statePath, cwd, detected.engine, new Date().toISOString())
    } catch (err) {
      // 落盘失败不阻断本会话注册（本次识别已生效），下次仍会重试。
      console.warn('[dsh-plugin-tav2] 引擎识别结果落盘失败：', err)
    }
    return detected.engine
  }
  return undefined
}

/** 应用翻译作用域的选项。 */
export interface ApplyTranslationScopeOptions {
  /** 强制装全套（/tav2-mode on 对当前会话 rearm 用）：即使工作区不是游戏目录也装 full。 */
  force?: boolean
}

export function applyTranslationScope(
  agent: Agent,
  config: Config,
  statePath: string,
  options?: ApplyTranslationScopeOptions,
): void {
  // 翻译分批 worker 的翻译作用域已在创建 setup 里注册，避免重复注册抛错。
  const agentId = String(agent.id)
  if (isTranslationWorker(agentId)) return
  const force = options?.force === true

  const perAgent: Config = {
    ...config,
    subagentMaxWorkers: config.subagentMaxWorkers ?? 2,
  }
  // 合并翻译专用 API：state.json（界面填的）覆盖 yaml 配置层；都空走宿主 ctx.llm。
  // 后台任务/子代理直传同一 perAgent Config，自动带过去，无需额外传播代码。
  perAgent.translationApi = mergeTranslationApi(config.translationApi, readStateApi(statePath))
  // 设置卡填写的 Ren'Py SDK 路径（state.json）覆盖 yaml 配置层。
  const sdk = readStateRenpySdk(statePath)
  if (sdk) perAgent.renpySdk = sdk
  perAgent.langOverride = resolveLang(config, agentId)

  const cwd = agent.session.header.cwd
  let engine: string | undefined
  let configYaml = false
  let multipleCandidates: string[] | undefined
  let kind: ScopeKind = 'slim'
  if (cwd) {
    const ws = applyWorkspaceCwd(perAgent, agentId, cwd)
    // 工作区=配置目录（cwd 自身或唯一子项目）：引擎以 config.yaml 为准，直接装全套。
    configYaml = ws.kind === 'config-dir'
    if (ws.kind === 'config-dir' || ws.kind === 'multiple') {
      kind = 'full'
      if (ws.kind === 'multiple') multipleCandidates = ws.candidates
    } else if (ws.kind === 'game-dir') {
      // 无 config.yaml：读缓存或现场识别；识别得到 → 全套，否则普通工作区 → 轻量引导。
      engine = resolveOrDetectEngine(statePath, cwd, perAgent)
      kind = engine ? 'full' : 'slim'
    }
  }
  if (force) kind = 'full'

  // 幂等：同等级不重复注册（slim → full 允许升级，由 init/rearm 触发）。
  if (scopeKindOf(agentId) === kind) return

  agentConfigs.set(agentId, perAgent)
  try {
    const actx = serviceResolvingContext(agent.ctx)
    actx.effect(() => () => {
      agentConfigs.delete(agentId)
      registrations.delete(agentId)
      clearScopeTrack(agentId)
    })
    const names = kind === 'full' ? ALL_TOOL_NAMES : SLIM_TOOL_NAMES
    const delta = missingToolNames(agentId, names)
    if (delta.length) {
      registerTools(actx, perAgent, delta)
      markToolsRegistered(agentId, delta)
    }
    if (kind === 'full' && !hasWorkflowSkill(agentId)) {
      registerRenpyWorkflowSkill(actx)
      markWorkflowSkill(agentId)
    }
    if (kind === 'full') {
      registerTranslationPersona(agent, perAgent)
    } else {
      registerTranslationAssistantPersona(agent)
    }
  } catch (err) {
    // 安装失败也记入 status（不再只 console.warn），让用户看到原因。
    recordRegistration({
      agentId,
      ok: false,
      installed: false,
      reason: 'error',
      error: String(err instanceof Error ? err.message : err),
      cwd,
      engine,
      configYaml,
      kind,
      at: new Date().toISOString(),
    })
    throw err
  }
  setScopeKind(agentId, kind)
  recordRegistration({
    agentId,
    ok: true,
    installed: true,
    reason: multipleCandidates ? 'workspace-multiple' : (kind === 'full' ? 'installed' : 'slim'),
    cwd,
    engine,
    configYaml,
    kind,
    candidates: multipleCandidates,
    at: new Date().toISOString(),
  })
}

/**
 * 把某会话从轻量引导（slim）升级为全套翻译作用域（增量注册，不重复）。
 * tav2_init 写盘成功后与 tav2_select_project 成功切换后都会调用，
 * 让已初始化项目上继续翻译工作而不需要重启会话（scope_track 是进程内 Map，
 * 重启后归零，select_project 是轻量工具集合里唯一能触发恢复全套的入口之一）。
 */
export function upgradeAgentScopeToFull(
  exec: { agent?: { id?: unknown; ctx?: Context } | null },
  config: Config,
): void {
  const agent = exec.agent as { id: unknown; ctx?: Context } | undefined
  if (!agent?.ctx) return
  const agentId = String(agent.id)
  const actx = serviceResolvingContext(agent.ctx)
  const delta = missingToolNames(agentId, ALL_TOOL_NAMES)
  if (delta.length) {
    registerTools(actx, config, delta)
    markToolsRegistered(agentId, delta)
  }
  if (!hasWorkflowSkill(agentId)) {
    registerRenpyWorkflowSkill(actx)
    markWorkflowSkill(agentId)
  }
  try {
    registerTranslationPersona(agent as never, config)
  } catch (err) {
    console.warn('[dsh-plugin-tav2] 升级翻译 persona 失败：', err)
  }
  setScopeKind(agentId, 'full')
}

/**
 * 切换某会话的目标语言（/tav2-lang 命令入口）：写入会话覆盖，
 * 并让已注册工具的下一次调用立即读到新语言（改 agent 作用域配置克隆）。
 */
export function setAgentLang(agentId: string, lang: string): void {
  setSessionLangOverride(agentId, lang)
  const cfg = agentConfigs.get(agentId)
  if (cfg) cfg.langOverride = lang
}

/** 会话当前生效的目标语言（供 /tav2-lang status 回显）。 */
export function agentLangOf(agentId: string, baseConfig: Config): string {
  return resolveLang(baseConfig, agentId)
}

/** /tav2-lang 命令的常用语言别名 → 规范写法。 */
const LANG_ALIASES: Record<string, string> = {
  zh: 'chinese',
  'zh-cn': 'zh-CN',
  en: 'english',
  'en-us': 'en-US',
  ja: 'japanese',
  'ja-jp': 'ja-JP',
}

/** /tav2-lang 命令结果（与宿主 commands 的 CommandResult 同形）。 */
export interface LangCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** 处理 /tav2-lang status|<lang>（测试可直调）。 */
export function handleLangCommand(agentId: string, rawInput: string, baseConfig: Config): LangCommandResult {
  const token = (rawInput ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!token) {
    return {
      kind: 'error',
      text: '用法：/tav2-lang status|<lang>（支持 chinese/english/zh-CN/en-US 等）',
    }
  }
  if (token === 'status') {
    const current = agentLangOf(agentId, baseConfig)
    return {
      kind: 'success',
      text: `本会话目标语言：${current}（写入 Ren'Py tl/${current}）`,
    }
  }
  if (!/^[a-z0-9-]{2,20}$/u.test(token)) {
    return {
      kind: 'error',
      text: `非法语言：${rawInput.trim()}（支持 chinese/english/zh-CN/en-US 等）`,
    }
  }
  const canonical = LANG_ALIASES[token] ?? token
  setAgentLang(agentId, canonical)
  return {
    kind: 'success',
    text: `已切换本会话目标语言为 ${canonical}；后续翻译写入 tl/${canonical}（英文产出为实验性）`,
  }
}
