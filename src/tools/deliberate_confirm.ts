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
  /** update 的目标审批 id（单条，兼容保留） */
  id?: number
  /** update 的新译名（单条，兼容保留） */
  target?: string
  /** update 批量：一次审批改多条译名并锁定 */
  updates?: Array<{ id: number; target: string }>
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
    case 'update': {
      const n = args.updates?.length ?? 1
      return n > 1
        ? `批量修改 ${n} 条术语推敲建议的译名并锁定`
        : `修改术语推敲建议 #${args.updates?.[0]?.id ?? args.id} 译名为「${args.updates?.[0]?.target ?? args.target ?? ''}」并锁定`
    }
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
        description: 'update 的目标审批 id（单条）',
      },
      target: {
        type: 'string',
        description: 'update 的新译名（单条）',
      },
      updates: {
        type: 'array',
        description: 'update 批量：[{id, target}]，一次审批改多条译名并锁定（优先于 id/target）',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '审批 id' },
            target: { type: 'string', description: '新译名' },
          },
          additionalProperties: false,
        },
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
            // 单条（id/target）与批量（updates）统一走同一条应用路径。
            const pendingUpdates: Array<{ id: number; target: string }> = (args.updates ?? [])
              .map((u) => ({ id: Number(u.id), target: String(u.target ?? '').trim() }))
              .filter((u) => Number.isFinite(u.id) && u.id > 0 && u.target)
            if (pendingUpdates.length === 0) {
              const id = args.id ?? 0
              const target = (args.target ?? '').trim()
              if (!target) return { ok: false, action: 'update', affected: 0, text: 'update 必须提供 target（或批量 updates）' }
              if (!id) return { ok: false, action: 'update', affected: 0, text: 'update 必须提供 id（或批量 updates）' }
              pendingUpdates.push({ id, target })
            }
            const applyOne = (item: { id: number; target: string }): string | null => {
              const a = db.approvalById(item.id)
              if (!a) return `审批 #${item.id} 不存在`
              const p = (a.payload ?? {}) as Record<string, unknown>
              const source = String(p.source ?? '').trim()
              if (!source) return `审批 #${item.id} 缺少 source`
              // S13：落库前清旧候选，改译名不叠加行
              db.clearCandidateTermsBySource(source)
              db.upsertTerm(source, item.target, String(p.category ?? ''), 'candidate', String(p.confidence ?? 'medium'), String(p.rationale ?? ''))
              const row = db.termBySourceTarget(source, item.target)
              const tid = Number(row?.id)
              if (Number.isFinite(tid)) db.decideTerm(tid, 'locked')
              db.decideApproval(item.id, 'approved')
              return null
            }
            let affected = 0
            const failures: string[] = []
            for (const item of pendingUpdates) {
              const err = applyOne(item)
              if (err) failures.push(err)
              else affected += 1
            }
            if (affected === 0) {
              return { ok: false, action: 'update', affected: 0, text: failures.join('；') || '没有任何条目被更新' }
            }
            const head = pendingUpdates.length > 1
              ? `已批量锁定 ${affected}/${pendingUpdates.length} 条译名。`
              : `已按新译名「${pendingUpdates[0]!.target}」锁定。`
            return {
              ok: true,
              action: 'update',
              affected,
              text: failures.length ? `${head} 失败：${failures.join('；')}` : head,
            }
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
