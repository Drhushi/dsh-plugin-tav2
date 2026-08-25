/**
 * tav2_diff：对比两个游戏目录的翻译文件差异（新增/修改/删除/未变）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { detectEngine, renpyAdapter } from '../engine/adapters'

export interface DiffArgs {
  from: string
  to: string
  lang?: string
}

export function runTsDiff(config: Config, args: DiffArgs): Tav2ToolResult & {
  engine?: string
  added?: string[]
  modified?: string[]
  removed?: string[]
  unchanged?: string[]
} {
  void config
  const detect = detectEngine(args.to)
  if (!detect.detected) {
    return { ok: false, command: `diff ${args.from} → ${args.to}`, text: detect.message, timedOut: false }
  }

  const adapter = renpyAdapter
  if (adapter.kind !== detect.engine) {
    return { ok: false, command: `diff ${args.from} → ${args.to}`, text: `引擎 ${detect.engine} 暂无 diff 适配器`, timedOut: false }
  }

  const result = adapter.diff(args.from, { fromRoot: args.from, toRoot: args.to, lang: args.lang ?? 'chinese' })
  const text = [
    `引擎：${detect.engine}`,
    `新增：${result.added.length}`,
    `修改：${result.modified.length}`,
    `删除：${result.removed.length}`,
    `未变：${result.unchanged.length}`,
    result.added.slice(0, 10).map((f) => `  + ${f}`).join('\n'),
    result.modified.slice(0, 10).map((f) => `  ~ ${f}`).join('\n'),
    result.removed.slice(0, 10).map((f) => `  - ${f}`).join('\n'),
  ].filter(Boolean).join('\n')
  return {
    ok: true,
    command: `diff ${args.from} → ${args.to}`,
    text,
    timedOut: false,
    engine: detect.engine,
    added: result.added,
    modified: result.modified,
    removed: result.removed,
    unchanged: result.unchanged,
  }
}

export function registerDiffTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_diff',
    description: '对比新旧游戏目录的翻译文件差异（新增/修改/删除/未变）。',
    parameters: {
      from: { type: 'string', required: true, description: '旧版本游戏根目录' },
      to: { type: 'string', required: true, description: '新版本游戏根目录' },
      lang: { type: 'string', description: '目标语言，默认 chinese' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          engine: { type: 'string' },
          added: { type: 'array', items: { type: 'string' } },
          modified: { type: 'array', items: { type: 'string' } },
          removed: { type: 'array', items: { type: 'string' } },
          unchanged: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ToolResult) => {
        const head = value.ok ? '差异对账完成' : '差异对账失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args: DiffArgs) {
      return runTsDiff(config, args)
    },
  }))
}
