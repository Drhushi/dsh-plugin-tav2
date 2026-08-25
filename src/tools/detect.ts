import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { detectEngine } from '../engine/adapters'

export interface Tav2DetectResult extends Tav2ToolResult {
  detected?: boolean
  engine?: string
  confidence?: number
  // dsh-tools 输出 schema 要求 JSON 值类型；探测布局只读展示，用 any 兼容对象字面量。
  layout?: Record<string, any>
}

/** 只读探测，不依赖 engineBackend 与 Python CLI。 */
export function runTsDetect(config: Config, path?: string): Tav2DetectResult {
  const root = (path || config.gameDirOverride || config.projectDir || process.cwd()).trim()
  const detect = detectEngine(root)
  const layoutLines = Object.entries(detect.layout)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  const text = [
    detect.message,
    `置信度：${detect.confidence}`,
    ...layoutLines,
  ].filter(Boolean).join('\n')
  return {
    ok: true,
    command: `detect ${root}`,
    text,
    timedOut: false,
    detected: detect.detected,
    engine: detect.engine,
    confidence: detect.confidence,
    layout: detect.layout,
  }
}

export function registerDetectTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_detect',
    description: '只读探测游戏根目录的引擎类型与文件布局（当前仅支持 Ren\'Py；识别到 Unity/Yarn 会明确提示不再支持）。',
    parameters: {
      path: {
        type: 'string',
        description: '游戏根目录；省略时使用插件 projectDir',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          detected: { type: 'boolean' },
          engine: { type: 'string' },
          confidence: { type: 'number' },
          layout: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2DetectResult) => {
        const head = value.ok ? '引擎探测完成' : '引擎探测失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args) {
      const path = typeof args.path === 'string' ? args.path : undefined
      return runTsDetect(config, path)
    },
  }))
}
