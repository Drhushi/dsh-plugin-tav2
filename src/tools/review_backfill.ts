import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { pythonBackendError, resultToTool, runTav2, startTav2Job } from '../core/tav2'
import { jobMeta } from '../present/meta'
import { startJobOrFallback, type JobDispatchResult } from './job_fallback'
import { runTsReviewBackfill, startTsReviewBackfillJob } from './ts_jobs'

export function registerReviewBackfillTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_review_backfill',
    description: '回填审校表 xlsx 到游戏 tl 目录并同步项目数据库（写操作，需审批；后台任务，后台不可用时经确认前台降级）。',
    parameters: {
      reviewFile: {
        type: 'string',
        required: true,
        description: '审校表 xlsx 的绝对路径（对应 --review-file）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['background', 'foreground'] },
          jobId: { type: 'string' },
          label: { type: 'string' },
          ok: { type: 'boolean' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value: JobDispatchResult) => {
        if (value.kind === 'foreground') {
          return [{
            type: 'text',
            text: value.ok ? `已前台降级执行：${value.label}\n${value.text}` : value.text,
          }]
        }
        return [{
          type: 'text',
          text: `已启动后台任务 ${value.jobId}：${value.label}。完成时用 job_output 读取统计结果。`,
        }]
      },
      presentationMeta: (_args, value) => jobMeta(_args, value),
    },
    async execute(args, exec) {
      const decision = await requestApproval(
        ctx,
        exec,
        `回填审校表 ${args.reviewFile}：会写回游戏 tl 目录并同步项目数据库（TM/单元状态）。`,
      )
      if (decision !== 'allowed') {
        return { kind: 'foreground' as const, label: '', ok: false, text: approvalDenialText(decision) }
      }

      const label = `tav2 backfill ${args.reviewFile}`
      const cliArgs = ['backfill', '--review-file', args.reviewFile]
      if (config.engineBackend !== 'python') {
        return startJobOrFallback(ctx, config, exec, {
          label,
          start: () => startTsReviewBackfillJob(ctx, config, { label, reviewFile: args.reviewFile }, exec.agent),
          foreground: async (_signal) => {
            let output = ''
            const log = (line: string) => { output += `${line}\n` }
            const outcome = await runTsReviewBackfill(ctx, config, { label, reviewFile: args.reviewFile }, log)
            return {
              ok: outcome.status === 'completed',
              text: `${output}${outcome.detail}`.trim(),
              timedOut: outcome.status === 'killed',
            }
          },
        })
      }
      const notReady = pythonBackendError(config, 'tav2_review_backfill')
      if (notReady) return { kind: 'foreground' as const, label: '', ok: false, text: notReady }
      return startJobOrFallback(ctx, config, exec, {
        label,
        start: () => startTav2Job(ctx, config, { label, args: cliArgs }, exec.agent),
        foreground: async (signal) => {
          const t = resultToTool(await runTav2({ config, args: cliArgs, signal }))
          return { ok: t.ok, text: `${t.command}\n${t.text}`, timedOut: t.timedOut }
        },
      })
    },
  }))
}
