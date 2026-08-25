/**
 * 后台任务启动兜底：job controller 不可用时经用户知情确认后前台降级。
 *
 * dsh-jobs 语义：ctx.jobs.start 只在有控制器 serve 本 agent 时才受理；
 * web profile 下无全局控制器，若本会话组合未挂 @deepseek-ai/dsh-tool-jobs
 * 或作用域不覆盖本 agent，会同步抛出
 *   'background jobs unavailable: no job controller serves this agent (...)'
 * 这里按 config.jobBackend 分派：auto=失败→知情确认→前台降级；
 * background=失败原样抛错；foreground=跳过后台直接前台执行。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalDecision } from '../core/approval'
import { approvalDenialText, requestApproval } from '../core/approval'
import type { Config } from '../config'

/** 判定一次 start 失败是否因"无 job controller 服务本 agent"。 */
export function isNoJobControllerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('no job controller serves this agent')
    || message.includes('background jobs unavailable')
}

/** 前台降级执行的同步结果（工具直接回给模型）。 */
export interface ForegroundRun {
  ok: boolean
  text: string
  timedOut?: boolean
}

/** 后台/前台分派后的统一工具返回值。 */
export type JobDispatchResult =
  | { kind: 'background'; jobId: string; label: string }
  | { kind: 'foreground'; label: string; ok: boolean; text: string; timedOut?: boolean }

export interface StartJobOrFallbackOptions {
  /** 任务一行描述（模型可见）。 */
  label: string
  /** 启动后台任务（返回 jobId）；可能抛出"无 job controller"错误。 */
  start: () => JobId
  /** 前台降级执行（同步返回结果，受 exec.signal 约束）。 */
  foreground: (signal: AbortSignal) => Promise<ForegroundRun>
}

const FALLBACK_REASON =
  '后台任务控制器不可用：本会话预设未挂载 job controller（@deepseek-ai/dsh-tool-jobs），无法启动后台任务。'
  + '可改为前台降级执行：会同步阻塞、无 job_output/job_kill、需按 limit/scenes 分批窗口推进（可能较慢）。'
  + '是否前台降级？'

function asDispatch(run: ForegroundRun, label: string): JobDispatchResult {
  return {
    kind: 'foreground',
    label,
    ok: run.ok,
    text: run.text,
    ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
  }
}

/**
 * 按 config.jobBackend 分派后台/前台：
 * - foreground：跳过 start 直接前台。
 * - background：start 失败原样抛错（不做降级）。
 * - auto（默认）：先 start；仅当抛出"无 job controller 服务本 agent"错误时，
 *   用 requestApproval 弹知情确认；放行→前台执行，拒绝/取消/审批不可用→返回 denial 文案；
 *   其它错误原样抛出。
 */
export async function startJobOrFallback(
  ctx: Context,
  config: Config,
  exec: ToolRunContext,
  options: StartJobOrFallbackOptions,
): Promise<JobDispatchResult> {
  const runForeground = async (): Promise<JobDispatchResult> =>
    asDispatch(await options.foreground(exec.signal), options.label)

  const mode = config.jobBackend ?? 'auto'
  if (mode === 'foreground') return runForeground()

  let jobId: JobId
  try {
    jobId = options.start()
  } catch (err) {
    if (mode === 'background' || !isNoJobControllerError(err)) throw err
    let decision: ApprovalDecision
    try {
      decision = await requestApproval(ctx, exec, FALLBACK_REASON)
    } catch {
      decision = 'unavailable'
    }
    if (decision !== 'allowed') {
      return asDispatch(
        { ok: false, text: `前台降级未获批准：${approvalDenialText(decision)}` },
        options.label,
      )
    }
    return runForeground()
  }
  return { kind: 'background', jobId, label: options.label }
}
