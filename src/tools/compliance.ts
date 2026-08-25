import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import type { Tav2ToolResult } from '../core/types'
import type { ComplianceRecord } from '../engine/db'
import { openKnowledge, tsKnowledgeResult } from './tsKnowledge'

/** 合法授权状态（G-1：unknown / local-only / authorized）。 */
const VALID_STATUS = new Set(['unknown', 'local-only', 'authorized'])

/** tav2_compliance 的结构化结果（前端阶段 A/B）。 */
export interface Tav2ComplianceResult extends Tav2ToolResult {
  compliance?: ComplianceRecord & { publicReleaseAllowed: boolean }
}

/** engineBackend=ts：读取或写入 G-1 授权合规记录。set 为空时只读。 */
export function runTsCompliance(
  config: Config,
  set?: Partial<ComplianceRecord>,
): Tav2ComplianceResult {
  if (set && set.status !== undefined && !VALID_STATUS.has(set.status)) {
    return {
      ok: false,
      command: 'engineBackend=ts',
      text: `非法授权状态：${set.status}（仅允许 unknown / local-only / authorized）`,
      timedOut: false,
    }
  }
  const knowledge = openKnowledge(config)
  try {
    if (set) {
      knowledge.db.setCompliance({
        status: set.status ?? 'unknown',
        author: set.author,
        copyrightOwner: set.copyrightOwner,
        authorized: set.authorized,
        allowedChannels: set.allowedChannels,
        licensePath: set.licensePath,
        notes: set.notes,
      })
    }
    const record = knowledge.db.getCompliance()
    const allowed = knowledge.db.isPublicReleaseAllowed()
    const channels = record.allowedChannels ?? []
    const compliance = { ...record, publicReleaseAllowed: allowed }
    const statusLabel = { unknown: '未记录', 'local-only': '仅本地自用', authorized: '已授权' }[record.status] ?? record.status
    const text = [
      `授权状态：${statusLabel}（${record.status}）`,
      record.author ? `作者/版权方：${record.author}` : '',
      record.copyrightOwner ? `版权方：${record.copyrightOwner}` : '',
      record.authorized ? `书面授权：已取得` : `书面授权：未取得`,
      channels.length > 0 ? `允许发布渠道：${channels.join('、')}` : '',
      record.licensePath ? `授权文件：${record.licensePath}` : '',
      record.notes ? `备注：${record.notes}` : '',
      record.updatedAt ? `记录时间：${record.updatedAt}` : '',
      allowed
        ? '公开发布：允许（G-1 通过）'
        : '禁止公开发布（G-1 未通过，只能本地自用/学习开发）',
    ].filter(Boolean).join('\n')
    return { ...tsKnowledgeResult(text), compliance }
  } catch (err) {
    return tsKnowledgeResult(
      `合规记录操作失败：${String(err instanceof Error ? err.message : err)}`,
      false,
    )
  } finally {
    knowledge.db.close()
  }
}

export function registerComplianceTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_compliance',
    description: '读取或写入 G-1 授权合规记录。不带 set 参数时只读当前记录；带 set 时写入（写操作，需审批）。',
    parameters: {
      set: {
        type: 'object',
        description: '要写入的合规字段；省略则只读',
        properties: {
          status: {
            type: 'string',
            enum: ['unknown', 'local-only', 'authorized'],
            description: '授权状态：unknown=未记录，local-only=仅本地自用，authorized=已取得书面授权',
          },
          author: { type: 'string', description: '作者' },
          copyrightOwner: { type: 'string', description: '版权方' },
          authorized: { type: 'boolean', description: '是否已取得书面授权' },
          allowedChannels: {
            type: 'array',
            items: { type: 'string' },
            description: '允许的发布渠道/范围，如 ["itch.io"]',
          },
          licensePath: { type: 'string', description: '授权文件路径' },
          notes: { type: 'string', description: '备注' },
        },
        additionalProperties: false,
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
          compliance: {
            type: 'object',
            description: '结构化合规记录（engineBackend=ts 时返回）',
            properties: {
              status: { type: 'string' },
              author: { type: 'string' },
              copyrightOwner: { type: 'string' },
              authorized: { type: 'boolean' },
              allowedChannels: { type: 'array', items: { type: 'string' } },
              licensePath: { type: 'string' },
              notes: { type: 'string' },
              updatedAt: { type: 'string' },
              publicReleaseAllowed: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ComplianceResult) => {
        const head = value.ok ? '合规记录操作完成' : '合规记录操作失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      const set = (args.set ?? undefined) as Partial<ComplianceRecord> | undefined
      if (config.engineBackend !== 'python') {
        if (!set) return runTsCompliance(config)
        // 写合规记录 = 元数据写操作，按既有约定需审批。
        const authorizedLabel = set.authorized === undefined ? '' : String(set.authorized)
        const decision = await requestApproval(
          ctx,
          exec,
          `写入 G-1 授权合规记录（status=${set.status ?? 'unknown'}, authorized=${authorizedLabel}），`
            + '公开部署将以此为准。',
        )
        if (decision !== 'allowed') {
          return { ok: false, command: '', text: approvalDenialText(decision), timedOut: false }
        }
        return runTsCompliance(config, set)
      }

      // Python 基线 CLI 无合规命令；G-1 是 TS 侧元数据能力，明确报错不静默降级。
      return {
        ok: false,
        command: '',
        text: 'engineBackend=python：G-1 授权合规仅 TS 后端支持，请改用 engineBackend=ts 后重试。',
        timedOut: false,
      }
    },
  }))
}
