import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'

/** tav2_worldbook_edit 参数：半交互维护世界书条目。 */
export interface WorldbookEditArgs {
  action: 'list' | 'confirm' | 'update' | 'delete' | 'add'
  /** list 时按状态过滤 */
  status?: 'proposed' | 'confirmed' | 'rejected'
  /** confirm/delete 的条目 id 列表 */
  ids?: number[]
  /** delete 时把关联术语标为 skip（仅锁译名、永不出卡）。 */
  skipTerm?: boolean
  /** update 的目标条目 id */
  id?: number
  /** add/update 的类别 */
  kind?: string
  /** add/update 的标题（中文名） */
  title?: string
  /** add/update 的内容 */
  content?: string
  /** add/update 的关键词（激活锚点） */
  keywords?: string[]
  /** add/update 的来源标记 */
  sourceRefs?: string[]
  /** add/update 关联的术语 source */
  linkedTerm?: string
}

interface WorldbookEditResult {
  ok: boolean
  action: string
  affected: number
  text: string
  items?: Array<Record<string, JsonValue>>
}

function describe(args: WorldbookEditArgs): string {
  switch (args.action) {
    case 'confirm': return `确认 ${(args.ids ?? []).length} 条世界书提案为正式条目`
    case 'delete': return `删除 ${(args.ids ?? []).length} 条世界书条目（软删）`
    case 'update': return `更新世界书条目 #${args.id}`
    case 'add': return `新增世界书条目：${args.title ?? ''}`
    default: return '世界书编辑'
  }
}

export function registerWorldbookEditTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_worldbook_edit',
    description: '半交互维护世界书条目：list 查看提案/确认项；confirm 确认提案；update 修改；delete 删除；add 人工补充（写操作需审批）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'confirm', 'update', 'delete', 'add'],
        description: '操作：list=查看 / confirm=确认提案 / update=修改 / delete=删除 / add=人工补充',
      },
      status: {
        type: 'string',
        enum: ['proposed', 'confirmed', 'rejected'],
        description: 'list 时按状态过滤（默认全部 active 条目）',
      },
      ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'confirm/delete 的条目 id 列表',
      },
      skipTerm: {
        type: 'boolean',
        description: 'delete 时把关联术语标为 skip（仅锁译名、永不出卡，重跑世界书不再出卡）',
      },
      id: {
        type: 'number',
        description: 'update 的目标条目 id',
      },
      kind: {
        type: 'string',
        enum: ['name', 'term', 'setting', 'lore', 'constant'],
        description: 'add/update 的类别',
      },
      title: {
        type: 'string',
        description: 'add/update 的标题（中文名，人物建议「中文名（English Name）」）',
      },
      content: {
        type: 'string',
        description: 'add/update 的内容',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'add/update 的关键词（激活锚点，拉丁词按词边界命中）',
      },
      sourceRefs: {
        type: 'array',
        items: { type: 'string' },
        description: 'add/update 的来源标记',
      },
      linkedTerm: {
        type: 'string',
        description: 'add/update 关联的术语 source（与术语译名一致性校验）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          affected: { type: 'number' },
          text: { type: 'string' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: false,
      },
      render: (_args, value: { ok?: boolean; text?: string }) => {
        const head = value.ok ? '世界书编辑完成' : '世界书编辑失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args: WorldbookEditArgs, exec): Promise<WorldbookEditResult> {
      // 只编辑项目 DB，无需重新提取文档。
      const engineCfg = loadEngineConfigFor(config)
      const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
      try {
        if (args.action === 'list') {
          const items = db.listWorldbook(args.status ?? null)
          const rows = items.map((e) =>
            `${e.id} [${String(e.status ?? '')}/${String(e.kind ?? '')}] ${String(e.title ?? '')}`
            + (e.linked_term ? ` 关联:${String(e.linked_term)}` : ''))
          return {
            ok: true,
            action: 'list',
            affected: items.length,
            text: rows.length ? rows.join('\n') : '（无条目）',
            items: items as unknown as Array<Record<string, JsonValue>>,
          }
        }

        const decision = await requestApproval(ctx, exec, describe(args))
        if (decision !== 'allowed') {
          return { ok: false, action: args.action, affected: 0, text: approvalDenialText(decision) }
        }

        switch (args.action) {
          case 'confirm': {
            const affected = db.confirmWorldbook(args.ids ?? [])
            return { ok: true, action: 'confirm', affected, text: `已确认 ${affected} 条世界书条目。` }
          }
          case 'delete': {
            const ids = args.ids ?? []
            const linked = db.worldbookLinkedTerms(ids)
            const affected = db.rejectWorldbook(ids)
            let skipAffected = 0
            if (args.skipTerm) {
              // 方案 D：删卡并标 skip——关联术语仅锁译名、永不出卡。
              for (const term of linked) {
                db.setTermWorldbookStatus(term, 'skip')
                skipAffected += 1
              }
            }
            const suffix = skipAffected > 0
              ? `，并将 ${skipAffected} 个关联术语标记 skip（仅译名、永不出卡）`
              : ''
            return { ok: true, action: 'delete', affected, text: `已删除 ${affected} 条世界书条目（软删）${suffix}。` }
          }
          case 'update': {
            const fields: Record<string, unknown> = {}
            if (args.title !== undefined) fields.title = args.title
            if (args.content !== undefined) fields.content = args.content
            if (args.keywords !== undefined) fields.keywords = args.keywords
            if (args.sourceRefs !== undefined) fields.source_refs = args.sourceRefs
            if (args.kind !== undefined) fields.kind = args.kind
            if (args.linkedTerm !== undefined) fields.linked_term = args.linkedTerm
            const ok = db.updateWorldbookEntry(args.id ?? 0, fields)
            return {
              ok,
              action: 'update',
              affected: ok ? 1 : 0,
              text: ok ? `已更新世界书条目 #${args.id}。` : `更新失败：条目 #${args.id} 不存在或无改动。`,
            }
          }
          case 'add': {
            if (!args.title || !args.title.trim()) {
              return { ok: false, action: 'add', affected: 0, text: 'add 必须提供 title' }
            }
            const id = db.addWorldbookEntry({
              kind: args.kind ?? 'lore',
              title: args.title,
              content: args.content ?? '',
              keywords: args.keywords ?? [],
              source_refs: args.sourceRefs ?? [],
              linked_term: args.linkedTerm ?? '',
            })
            return { ok: true, action: 'add', affected: 1, text: `已新增世界书条目 #${id}。` }
          }
          default:
            return { ok: false, action: args.action, affected: 0, text: `未知操作：${String(args.action)}` }
        }
      } catch (err) {
        return {
          ok: false,
          action: args.action,
          affected: 0,
          text: `世界书编辑失败：${String(err instanceof Error ? err.message : err)}`,
        }
      } finally {
        db.close()
      }
    },
  }))
}
