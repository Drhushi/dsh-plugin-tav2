/**
 * 翻译分批的子代理编排（ts 后端）：
 * - 纯函数 planSubagentBatches：把待译场景窗口切成互不重叠的批次；
 * - runTranslationWorker：按 dsh 子代理契约创建子代理，并在创建 setup 里
 *   显式注册翻译作用域（tav2 工具 + 技能 + worker persona）——因为 dsh 的
 *   spawn 子代理是 fresh flat scope，不会继承父代理 agent 作用域的注册
 *   （已在 harness 源码核实，这是确定性规则，不是可选项）；
 * - 并行池 runBatchesWithWorkers + 结果聚合，供 ts_jobs 编排使用。
 *
 * 子代理创建契约镜像 @deepseek-ai/dsh-subagent-in-process-driver：
 * session meta（cwd/parentSession/origin/delegationDepth）、委托策略
 * （sandbox 覆盖 + approval=never）、结果读取（finalAssistantOutput）、
 * 信号取消与 quiescent dispose。只使用插件自带的 dsh-* 依赖，不 import
 * dsh-subagent（保持宿主包版本无关）。
 *
 * 防卡死：whenIdle 等待加 WORKER_IDLE_TIMEOUT_MS 超时，超时即取消子代理并
 * 返回失败结果，避免“子代理永不结算 → 后台任务永久 running”的整链悬挂。
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { serviceResolvingContext } from '../harness'
import { registerTranslationWorkerPersona, TRANSLATION_DELEGATION_CONTEXT } from '../persona'
import { registerWorkflowSkill } from '../skills/workflow'
import { registerTools } from './index'
import { applyWorkspaceCwd } from './select_project'

/** 已创建为翻译 worker 的子代理 session id（避免 agent/created 二次注册）。 */
const translationWorkerIds = new Set<string>()

/** 判断一个 agent 是否是本插件的翻译分批 worker。 */
export function isTranslationWorker(sessionId: string): boolean {
  return translationWorkerIds.has(sessionId)
}

/** 单个翻译 worker 从派发到静默的最长等待（毫秒）：避免 whenIdle 永不结算时
 *  后台任务永久挂起。30 分钟足够覆盖一个批次（单次 LLM 请求已由 120s 超时保护）。 */
export const WORKER_IDLE_TIMEOUT_MS = 30 * 60_000

/** 给 Promise 加超时：超时触发 onTimeout（如取消子代理）并 reject。 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
  message = '等待超时',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error(message))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** 取子代理会话最后一条 assistant 消息的纯文本（最终回复含 STATS 行）。 */
export function lastAssistantText(events: readonly SessionEvent[]): string {
  let last = ''
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
    const text = (message?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    if (text) last = text
  }
  return last
}

/** 一个子代理负责的批次。 */
export interface TranslationWorkerBatch {
  /** 场景 id 列表（按原文档顺序，全局唯一，互不重叠）。 */
  sceneIds: string[]
  /** 人类可读标签（日志/UI 用）。 */
  label: string
}

/** 子代理运行请求。 */
export interface TranslationWorkerRequest {
  /** 宿主 ctx（解析 agents/settings 等服务）。 */
  ctx: Context
  /** 父 agent（通常是发起 tav2_translate_batch 的主 agent）。 */
  parent: Agent
  /** 主 agent 的有效插件配置。 */
  config: Config
  /** 本批要翻译的场景。 */
  batch: TranslationWorkerBatch
  /** 任务取消信号（后台任务取消时传给子代理）。 */
  signal: AbortSignal
}

/** 子代理运行结果。 */
export interface TranslationWorkerResult {
  childId: string
  output: string
  ok: boolean
  error?: string
}

/** 把待译场景窗口切成批次（limit=窗口大小；maxWorkers=并行上限）。 */
export function planSubagentBatches(
  pendingSceneIds: string[],
  limit: number | undefined,
  maxWorkers: number,
): { batches: string[][]; total: number } {
  const window = pendingSceneIds.slice(
    0,
    limit == null ? pendingSceneIds.length : Math.max(0, Math.floor(limit)),
  )
  const count = window.length
  if (count <= 1 || maxWorkers <= 1) {
    return { batches: count > 0 ? [window] : [], total: count }
  }
  const workers = Math.min(Math.max(1, Math.floor(maxWorkers)), count)
  const base = Math.floor(count / workers)
  const extra = count % workers
  const batches: string[][] = []
  let cursor = 0
  for (let i = 0; i < workers; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    if (size <= 0) continue
    batches.push(window.slice(cursor, cursor + size))
    cursor += size
  }
  return { batches, total: count }
}

/** 构造子代理任务文本。 */
export function buildWorkerTask(batch: TranslationWorkerBatch, cwd: string | undefined): string {
  const head = batch.sceneIds.slice(0, 8).join('、')
  const more = batch.sceneIds.length > 8 ? ` 等共 ${batch.sceneIds.length} 个场景` : ''
  const scenesArg = `["${batch.sceneIds.join('","')}"]`
  return [
    `你是翻译分批 worker。工作区（游戏目录）：${cwd || '（未设置）'}`,
    `本批任务：翻译以下 ${batch.sceneIds.length} 个场景（场景 id：${head}${more}）。`,
    '步骤：',
    '1. 先 tav2_status 确认项目状态（只读）；',
    `2. 调用 tav2_translate_batch，参数 scenes=${scenesArg}（只翻本批，不要改参数、不要加 limit）；`,
    '3. 等后台任务完成：用 job_output 读取统计；失败时用 job_list/job_kill 管理并如实报告；',
    '4. 完成后跑 tav2_report 拿到本批统计；',
    '5. 最后回复一行 STATS JSON：STATS {"scenes":N,"units":M,"tokens":T,"failed":F}',
    '   （N=本批场景数、M=本批译出单元数、T=本轮 tokens、F=失败单元数），再附一句简短总结。',
    '约束：不要调用子代理工具；不要做部署/回填/术语锁定等写操作；除 tl 目录外不要修改游戏目录。',
  ].join('\n')
}

/** 从子代理输出解析 STATS 行。 */
export function parseWorkerStats(output: string): { scenes: number; units: number; tokens: number; failed: number } | undefined {
  const match = /STATS\s+(\{[\s\S]*?\})/u.exec(output)
  if (!match?.[1]) return undefined
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    return {
      scenes: Number(raw.scenes) || 0,
      units: Number(raw.units) || 0,
      tokens: Number(raw.tokens) || 0,
      failed: Number(raw.failed) || 0,
    }
  } catch {
    return undefined
  }
}

/** 汇总子代理结果。 */
export function aggregateWorkerResults(
  results: TranslationWorkerResult[],
): { totalScenes: number; totalUnits: number; totalTokens: number; totalFailed: number; failedBatches: string[]; done: number } {
  let totalScenes = 0
  let totalUnits = 0
  let totalTokens = 0
  let totalFailed = 0
  const failedBatches: string[] = []
  let done = 0
  for (const result of results) {
    if (!result.ok) {
      failedBatches.push(result.childId)
      continue
    }
    done += 1
    const stats = parseWorkerStats(result.output)
    totalScenes += stats?.scenes ?? 0
    totalUnits += stats?.units ?? 0
    totalTokens += stats?.tokens ?? 0
    totalFailed += stats?.failed ?? 0
  }
  return { totalScenes, totalUnits, totalTokens, totalFailed, failedBatches, done }
}

/** 有界并行池：最多 limit 个任务同时运行，保持输入顺序返回。 */
export async function runBatchesWithWorkers<T>(
  items: string[][],
  limit: number,
  fn: (batch: string[], index: number) => Promise<T>,
): Promise<T[]> {
  const queue = [...items]
  const out = new Array<T>(items.length)
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (queue.length > 0) {
      const index = items.length - queue.length
      const item = queue.shift()!
      out[index] = await fn(item, index)
    }
  })
  await Promise.all(workers)
  return out
}

/** 子代理的 AgentOptions：继承父代理路由，深度由 meta.delegationDepth 持久化。 */
function childAgentOptions(parent: Agent): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (parent.options.provider !== undefined) options.provider = parent.options.provider
  if (parent.options.model !== undefined) options.model = parent.options.model
  if (parent.options.maxTokens !== undefined) options.maxTokens = parent.options.maxTokens
  return options
}

/** 把父会话的委托策略固定到子会话（sandbox 覆盖 + approval=never）。 */
function appendDelegationPolicy(
  childSession: { append(type: string, data: Record<string, unknown>): unknown },
  sandboxMode: unknown,
  approvalPinned: boolean,
): void {
  if (sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
  }
  if (approvalPinned) {
    childSession.append('approval/policy', { policy: 'never', source: 'delegation' })
  }
}

/** 子代理的插件配置：继承主配置，但关闭子代理再派发（防递归），并按 cwd 覆盖项目。 */
function workerConfigFor(config: Config, cwd: string | undefined, sessionKey: string): Config {
  const childConfig: Config = {
    ...config,
    subagentMaxWorkers: 1,
  }
  if (cwd) applyWorkspaceCwd(childConfig, sessionKey, cwd)
  return childConfig
}

/**
 * 创建并驱动一个翻译分批子代理，返回其结果。子代理在创建 setup 里显式注册
 * 翻译作用域（tav2 工具 + 技能 + worker persona + 委托作用域声明）。
 */
export async function runTranslationWorker(request: TranslationWorkerRequest): Promise<TranslationWorkerResult> {
  const childId = SessionId(randomUUID())
  const childIdText = String(childId)
  const parent = request.parent
  const parentHeader = parent.session.header
  const parentDepth = typeof parentHeader.delegationDepth === 'number' ? parentHeader.delegationDepth : 0
  const childDepth = Math.max(0, parentDepth) + 1

  const agents = (parent.ctx as unknown as { agents?: { create?: (options: unknown) => Promise<AgentHandle> } }).agents
  if (!agents?.create) {
    return { childId: childIdText, output: '', ok: false, error: 'agents 服务不可用，无法派生子代理' }
  }

  // 委托策略：父会话的显式 sandbox 覆盖 + approval 存在时固定为 never。
  const parentAny = parent.ctx as unknown as {
    get?: (key: string) => { overrideOf?: (session: unknown) => unknown } | undefined
  }
  const sandboxPolicy = parentAny.get?.('sandboxPolicy')
  const sandboxMode = sandboxPolicy?.overrideOf?.(parent.session)
  const approvalPinned = parentAny.get?.('approval') !== undefined

  const agentPresets = (parent.ctx as unknown as {
    get?: (key: string) => { composedPreset?: (ctx: unknown) => string | undefined } | undefined
  }).get?.('agentPresets')
  const composedPreset = agentPresets?.composedPreset?.(parent.ctx)

  let handle: AgentHandle | undefined
  try {
    handle = await agents.create({
      sessionId: childId,
      meta: {
        ...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}),
        ...(composedPreset !== undefined ? { agentPreset: composedPreset } : {}),
        parentSession: parentHeader.id,
        origin: 'subagent',
        delegationDepth: childDepth,
      },
      agentOptions: childAgentOptions(parent),
      signal: request.signal,
      setup: (childCtx: Context): void => {
        translationWorkerIds.add(childIdText)
        const child = (childCtx as unknown as { agent?: Agent }).agent
        // 1) 加入父代理的 preset 组合（普通工具/任务/文件等由 preset 提供）。
        const childPresets = childCtx.get('agentPresets') as
          | { composeFrom?: (ctx: unknown, parentCtx: unknown) => unknown }
          | undefined
        childPresets?.composeFrom?.(childCtx, parent.ctx)
        if (!child) return
        // 2) 委托策略固定。
        appendDelegationPolicy(
          child.session as unknown as { append(type: string, data: Record<string, unknown>): unknown },
          sandboxMode,
          approvalPinned,
        )
        // 3) 翻译 worker 作用域：工具 + 技能 + persona + 委托作用域声明。
        const childConfig = workerConfigFor(request.config, child.session.header.cwd, childIdText)
        const actx = serviceResolvingContext(childCtx)
        registerTools(actx, childConfig)
        registerWorkflowSkill(actx)
        registerTranslationWorkerPersona(actx)
        actx.systemPrompt.context({
          name: 'subagent:delegation',
          order: 120,
          text: TRANSLATION_DELEGATION_CONTEXT,
        })
      },
    })
  } catch (err) {
    translationWorkerIds.delete(childIdText)
    return {
      childId: childIdText,
      output: '',
      ok: false,
      error: `子代理创建失败：${String(err instanceof Error ? err.message : err)}`,
    }
  }

  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (!request.signal.aborted) {
      const content: ContentBlock[] = [{ type: 'text', text: buildWorkerTask(request.batch, child.session.header.cwd) }]
      child.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await withTimeout(
        child.whenIdle(),
        WORKER_IDLE_TIMEOUT_MS,
        () => child.cancel({ kind: 'parent' }),
        `子代理等待超时（${WORKER_IDLE_TIMEOUT_MS}ms），已取消`,
      )
    }
    const output = lastAssistantText(child.session.events)
    if (flags.cancelled) {
      return { childId: childIdText, output, ok: false, error: '子代理任务被取消' }
    }
    return { childId: childIdText, output, ok: output.length > 0 }
  } catch (err) {
    return {
      childId: childIdText,
      output: '',
      ok: false,
      error: `子代理运行失败：${String(err instanceof Error ? err.message : err)}`,
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    translationWorkerIds.delete(childIdText)
    try {
      await handle.dispose()
    } catch {
      // 释放失败不掩盖子代理结果；任务注册表会保留会话供排查。
    }
  }
}
