import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 审批决策（closed union，工具据此决定继续还是中止）。 */
export type ApprovalDecision = 'allowed' | 'rejected' | 'cancelled' | 'unavailable'

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

/** 把审批决策渲染成给模型的失败说明。 */
export function approvalDenialText(decision: ApprovalDecision): string {
  switch (decision) {
    case 'rejected':
      return '操作被拒绝'
    case 'cancelled':
      return '审批请求已取消'
    case 'unavailable':
      return '审批不可用（无应答方，按失败关闭）'
    default:
      return '未知审批结果'
  }
}
