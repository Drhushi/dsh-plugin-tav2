import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { resultToTool, runTav2, startTav2Job } from '../core/tav2'
import { loadEngineConfigFor } from '../engine/config'
import { jobMeta } from '../present/meta'
import { startJobOrFallback, type JobDispatchResult } from './job_fallback'
import { runSingleTsJob, startTsBatchTranslateJob } from './ts_jobs'
import { resolveTranslationStyle, styleDenialText } from './translationStyle'

export interface TranslateBatchArgs {
  limit?: number
  review?: boolean
  batchMode?: 'auto' | 'fixed'
  budget?: number
  /**
   * 显式指定本轮要翻译的场景 id（分批窗口）。ts 后端按此精确分窗，
   * 多个子代理并行互不重叠；python 后端不支持。
   */
  scenes?: string[]
}

/** 构造 tav2 translate 的 CLI 参数（供测试复用）。 */
export function buildTranslateBatchArgs(args: TranslateBatchArgs): string[] {
  const cliArgs = ['translate']
  if (args.limit != null) cliArgs.push('--limit', String(args.limit))
  if (args.review) cliArgs.push('--review')
  if (args.batchMode) cliArgs.push('--batch-mode', args.batchMode)
  if (args.budget != null) cliArgs.push('--budget', String(args.budget))
  return cliArgs
}

export function registerTranslateBatchTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_translate_batch',
    description: '执行 tav2 双阶段翻译（后台任务；后台不可用时经确认前台降级）。limit=本轮总场景窗口（待译场景数）；scenes 可显式指定场景 id 分批；'
      + '开启子代理分批时按 limit/batch 语义切批并行翻译（上限见配置 subagentMaxWorkers）；review=true 产出审校 xlsx。',
    parameters: {
      limit: {
        type: 'number',
        description: "本轮总窗口的场景数（Ren'Py 按场景计算）。",
      },
      review: {
        type: 'boolean',
        description: '审校模式：产出 xlsx 供人工确认（对应 --review）',
      },
      batchMode: {
        type: 'string',
        enum: ['auto', 'fixed'],
        description: '分批模式（对应 --batch-mode）',
      },
      budget: {
        type: 'number',
        description: '本轮 token 预算，0=用配置默认（对应 --budget）',
      },
      scenes: {
        type: 'array',
        items: { type: 'string' },
        description: '显式指定本轮要翻译的场景 id 列表（ts 后端分批窗口；缺省用 limit 取前 N 个待译场景）',
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
            text: value.ok ? `已前台降级执行：${value.label}\n${value.text}\n续跑请再调一次（按 limit/scenes 分批窗口推进）` : value.text,
          }]
        }
        return [{
          type: 'text',
          text: `已启动后台任务 ${value.jobId}：${value.label}。完成时会收到通知，用 job_output 读取统计结果。`,
        }]
      },
      presentationMeta: (_args, value) => jobMeta(_args, value),
    },
    async execute(args: TranslateBatchArgs, exec) {
      if (args.scenes !== undefined && args.scenes.length > 0 && config.engineBackend === 'python') {
        throw new Error('scenes 分批窗口只支持 engineBackend=ts；python 后端请用 limit 串行分批')
      }
      const cliArgs = buildTranslateBatchArgs(args)
      const label = [
        'tav2 translate',
        args.limit != null ? `limit=${args.limit}` : '',
        args.scenes?.length ? `scenes=${args.scenes.length}` : '',
      ].filter(Boolean).join(' ')
      // 方案 A：翻译风格不默认——启动时解析一次（未设则询问，无通道降级 faithful，拒绝则中止）。
      let styleOverride: { preset: string; prompt: string } | undefined
      if (config.engineBackend === 'ts') {
        try {
          const engineCfg = loadEngineConfigFor(config)
          const style = await resolveTranslationStyle(ctx, exec, config, engineCfg)
          if (style.source === 'rejected') {
            return {
              kind: 'foreground' as const,
              label,
              ok: false,
              text: `翻译已中止：${styleDenialText('rejected')}。`,
              timedOut: false,
            }
          }
          if (style.preset || style.prompt) styleOverride = { preset: style.preset, prompt: style.prompt }
        } catch {
          // 项目配置不可解析时不在风格解析处提前抛错，交给任务自身报错。
        }
      }
      const tsOptions = {
        label,
        limit: args.limit,
        review: args.review === true,
        budget: args.budget,
        scenes: args.scenes,
        styleOverride,
      }
      return startJobOrFallback(ctx, config, exec, {
        label,
        start: () => config.engineBackend === 'python'
          ? startTav2Job(ctx, config, { label, args: cliArgs }, exec.agent)
          : startTsBatchTranslateJob(ctx, config, tsOptions, exec.agent),
        foreground: async (signal) => {
          if (config.engineBackend === 'python') {
            const t = resultToTool(await runTav2({ config, args: cliArgs, signal }))
            return { ok: t.ok, text: `${t.command}\n${t.text}`, timedOut: t.timedOut }
          }
          // ts：前台单批直跑一个窗口（无子代理并行），未传 limit/scenes 时默认 1 个场景。
          let output = ''
          const log = (line: string) => { output += `${line}\n` }
          const outcome = await runSingleTsJob(ctx, config, {
            ...tsOptions,
            limit: args.limit ?? 1,
          }, log, signal)
          return {
            ok: outcome.status === 'completed',
            text: `${output}${outcome.detail}`.trim(),
            timedOut: outcome.status === 'killed',
          }
        },
      })
    },
  }))
}
