import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { pythonBackendError, resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { verifyRenpy } from '../engine/adapters/renpy/verify'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'

/** engineBackend=ts：用 TS Ren'Py 适配器做标识符/标签校验。 */
export function runTsCheck(config: Config): Tav2ToolResult {
  try {
    const engineCfg = loadEngineConfigFor(config)
    const lines: string[] = []
    let ok = true
    if (engineCfg.engine === 'renpy') {
      const report = verifyRenpy(engineCfg.gameDir, engineCfg.lang)
      // S3：0 提取单元 ≠ 通过——用户无法区分「没东西」和「全绿」。
      const empty = report.dialogue_blocks === 0 && report.strings === 0
      // S17 护栏：invalid_speakers>0（裸 ... / ??? 说话人，Ren'Py 会拒绝启动）也必须判失败。
      ok = empty
        ? false
        : (report.missing_blocks === 0 && report.tag_violations === 0 && report.invalid_speakers === 0)
      lines.push(empty
        ? '⚠️ 项目未初始化/无提取单元（0 对话块 / 0 字符串），请先 tav2_prepare 提取'
        : JSON.stringify(report, null, 2))
    } else {
      lines.push(`引擎：${engineCfg.engine}（格式校验仅 renpy，跳过）`)
    }
    // 知识库一致性：世界书↔锁定术语译名冲突（引擎无关）。
    const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
    try {
      const conflicts = db.worldbookTermConflicts()
      if (conflicts.length === 0) {
        lines.push('世界书↔术语一致性：通过')
      } else {
        ok = false
        for (const c of conflicts) {
          lines.push(`冲突：术语 ${c.term} 锁定为「${c.termTarget}」，世界书条目 #${c.entryId} 标题为「${c.entryTitle}」`)
        }
      }
    } finally {
      db.close()
    }
    return { ok, command: 'engineBackend=ts', text: lines.join('\n'), timedOut: false }
  } catch (err) {
    return {
      ok: false,
      command: 'engineBackend=ts',
      text: `完整性校验失败：${String(err instanceof Error ? err.message : err)}`,
      timedOut: false,
    }
  }
}

export function registerCheckTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_check',
    description: '校验翻译完整性（标识符/标签），返回 JSON 报告。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ToolResult) => {
        const head = value.ok ? '完整性校验通过' : '完整性校验未通过'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(_args, exec) {
      if (config.engineBackend !== 'python') return runTsCheck(config)
      const notReady = pythonBackendError(config, 'tav2_check')
      if (notReady) return { ok: false, command: '', text: notReady, timedOut: false }
      const result = await runTav2({ config, args: ['check'], signal: exec.signal })
      return resultToTool(result)
    },
  }))
}
