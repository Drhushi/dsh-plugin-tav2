/**
 * dsh 审批桥（工具层专用）：把审批契约（src/core/approval.ts，与 dsh 无关）
 * 接到 dsh 的 ctx.approval。core 不依赖 dsh——本模块是审批的唯一 dsh 绑定点。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { approvalDenialText, type ApprovalDecision } from '../core/approval'

export { approvalDenialText, type ApprovalDecision }

/**
 * 在工具执行内发起一次审批请求。
 * 必须处于打开的 turn 中（工具执行天然满足）。只有 allowed-once 是放行。
 */
export async function requestApproval(
  ctx: Context,
  exec: ToolRunContext,
  reason: string,
): Promise<ApprovalDecision> {
  if (!exec.agent) return 'unavailable'
  const outcome: ApprovalOutcome = await ctx.approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  return outcome === 'allowed-once' ? 'allowed' : outcome
}
