import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'

/** tav2_deliberate_confirm 参数：推敲定论（半交互）。 */
export interface DeliberateConfirmArgs {
  action: 'list' | 'approve' | 'reject' | 'update'
  /** list 时按类别过滤（默认 term） */
  kind?: string
  /** approve/reject 的审批 id 列表 */
  ids?: number[]
  /** update 的目标审批 id */
  id?: number
  /** update 的新译名 */
  target?: string
}

interface DeliberateConfirmResult {
  ok: boolean
  action: string
  affected: number
  text: string
  items?: Array<Record<string, JsonValue>>
}

function describe(args: DeliberateConfirmArgs): string {
  switch (args.action) {
    case 'approve': return `批准 ${(args.ids ?? []).length} 条术语推敲建议并锁定`
    case 'reject': return `拒绝 ${(args.ids ?? []).length} 条术语推敲建议`
    case 'update': return `修改术语推敲建议 #${args.id} 译名为「${args.target ?? ''}」并锁定`
    default: return '术语推敲定论'
  }
}

export function registerDeliberateConfirmTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_deliberate_confirm',
    description: '推敲定论（半交互）：list 查看待审批推敲建议；approve 批准并锁定；reject 拒绝；update 改译名后锁定（写操作需审批）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'approve', 'reject', 'update'],
        description: '操作：list=查看 / approve=批准锁定 / reject=拒绝 / update=改译名后锁定',
      },
      kind: {
        type: 'string',
        description: 'list 时按类别过滤（默认 term）',
      },
      ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'approve/reject 的审批 id 列表',
      },
      id: {
        type: 'number',
        description: 'update 的目标审批 id',
      },
      target: {
        type: 'string',
        description: 'update 的新译名',
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
        const head = value.ok === true ? '推敲定论完成' : '推敲定论失败'
        return [{ type: 'text', text: `${head}\n${value.text ?? ''}` }]
      },
    },
    async execute(args: DeliberateConfirmArgs, exec): Promise<DeliberateConfirmResult> {
      const engineCfg = loadEngineConfigFor(config)
      const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
      try {
        if (args.action === 'list') {
          const kind = args.kind ?? 'term'
          const items = db.pendingApprovals().filter((a) => String(a.kind ?? '') === kind)
          const rows = items.map((a) => {
            const p = (a.payload ?? {}) as Record<string, unknown>
            const reason = p.rationale ? ` 理由:${String(p.rationale)}` : ''
            return `#${a.id} [${String(a.kind ?? '')}] ${String(p.source ?? '')} → ${String(p.target ?? '')}（${String(p.confidence ?? '?')}）${reason}`
          })
          return {
            ok: true,
            action: 'list',
            affected: items.length,
            text: rows.length ? rows.join('\n') : `（无 ${kind} 待审批项）`,
            items: items as unknown as Array<Record<string, JsonValue>>,
          }
        }

        const decision = await requestApproval(ctx, exec, describe(args))
        if (decision !== 'allowed') {
          return { ok: false, action: args.action, affected: 0, text: approvalDenialText(decision) }
        }

        switch (args.action) {
          case 'approve': {
            const ids = args.ids ?? []
            let affected = 0
            for (const id of ids) {
              const a = db.approvalById(id)
              if (!a) continue
              const p = (a.payload ?? {}) as Record<string, unknown>
              const source = String(p.source ?? '').trim()
              const target = String(p.target ?? '').trim()
              if (source && target) {
                // S13：落库前清旧候选，避免 (source,'') 占位行与锁定行并存
                db.clearCandidateTermsBySource(source)
                db.upsertTerm(source, target, String(p.category ?? ''), 'candidate', String(p.confidence ?? 'medium'), String(p.rationale ?? ''))
                const row = db.termBySourceTarget(source, target)
                const tid = Number(row?.id)
                if (Number.isFinite(tid)) db.decideTerm(tid, 'locked')
              }
              if (db.decideApproval(id, 'approved')) affected += 1
            }
            return { ok: true, action: 'approve', affected, text: `已批准并锁定 ${affected} 条术语。` }
          }
          case 'reject': {
            const ids = args.ids ?? []
            let affected = 0
            for (const id of ids) {
              if (db.decideApproval(id, 'rejected')) affected += 1
            }
            return { ok: true, action: 'reject', affected, text: `已拒绝 ${affected} 条术语建议。` }
          }
          case 'update': {
            const id = args.id ?? 0
            const target = (args.target ?? '').trim()
            if (!target) {
              return { ok: false, action: 'update', affected: 0, text: 'update 必须提供 target' }
            }
            const a = db.approvalById(id)
            if (!a) {
              return { ok: false, action: 'update', affected: 0, text: `审批 #${id} 不存在` }
            }
            const p = (a.payload ?? {}) as Record<string, unknown>
            const source = String(p.source ?? '').trim()
            if (!source) {
              return { ok: false, action: 'update', affected: 0, text: `审批 #${id} 缺少 source` }
            }
            // S13：落库前清旧候选，改译名不叠加行
            db.clearCandidateTermsBySource(source)
            db.upsertTerm(source, target, String(p.category ?? ''), 'candidate', String(p.confidence ?? 'medium'), String(p.rationale ?? ''))
            const row = db.termBySourceTarget(source, target)
            const tid = Number(row?.id)
            if (Number.isFinite(tid)) db.decideTerm(tid, 'locked')
            db.decideApproval(id, 'approved')
            return { ok: true, action: 'update', affected: 1, text: `已按新译名「${target}」锁定 ${source}。` }
          }
          default:
            return { ok: false, action: args.action, affected: 0, text: `未知操作：${String(args.action)}` }
        }
      } catch (err) {
        return {
          ok: false,
          action: args.action,
          affected: 0,
          text: `推敲定论失败：${String(err instanceof Error ? err.message : err)}`,
        }
      } finally {
        db.close()
      }
    },
  }))
}
