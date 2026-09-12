/**
 * 审批契约（与 dsh 无关）：审批决策 closed union 与给模型的拒绝文案。
 * dsh 绑定（ctx.approval 桥）在 src/tools/approval.ts——core 只定义契约，
 * 其他宿主（CLI/MCP）按各自交互形态实现同一套决策语义。
 */

/** 审批决策（closed union，工具据此决定继续还是中止）。 */
export type ApprovalDecision = 'allowed' | 'rejected' | 'cancelled' | 'unavailable'

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
