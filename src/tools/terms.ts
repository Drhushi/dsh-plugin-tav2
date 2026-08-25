import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { scanLines } from '../engine/scanning'
import { lockTerms, seedTerms } from '../engine/terms'
import { openKnowledge, tsKnowledgeResult } from './tsKnowledge'
import { termsMeta } from '../present/meta'

export interface TermsApplyItem {
  /** 源词 */
  source: string
  /** 译文 */
  target: string
  /** 类别（可选） */
  category?: string
}

/** tav2_terms 的结构化结果（前端阶段 A）。 */
export interface Tav2TermsResult extends Tav2ToolResult {
  terms?: {
    scanned?: number
    seeded?: number
    locked?: number
    updated?: number
    deleted?: number
    items?: Array<{ id: number; source: string; target: string; category: string; status: string; confidence: string }>
  }
}

/** engineBackend=ts：扫描术语候选入库。 */
function runTsScan(ctx: Context, config: Config): Tav2TermsResult {
  void ctx
  const knowledge = openKnowledge(config)
  try {
    const candidates = scanLines(knowledge.scanLines, knowledge.engineCfg)
    const seeded = seedTerms(knowledge.db, candidates)
    return {
      ...tsKnowledgeResult(`扫描出 ${candidates.length} 个候选，入库 ${seeded} 个。\n下一步：使用 tav2_deliberate 多方位推敲。`),
      terms: { scanned: candidates.length, seeded },
    }
  } catch (err) {
    return tsKnowledgeResult(`术语扫描失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

/** engineBackend=ts：批量锁定术语。 */
function runTsApply(config: Config, items: TermsApplyItem[]): Tav2TermsResult {
  const knowledge = openKnowledge(config)
  try {
    const locked = lockTerms(knowledge.db, items.map((t) => [t.source, t.target, t.category ?? '']))
    return { ...tsKnowledgeResult(`已锁定 ${locked} 条术语。`), terms: { locked } }
  } catch (err) {
    return tsKnowledgeResult(`术语锁定失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

export interface TermsUpdateItem {
  /** 按 id 定位（优先）；缺省时用 source 定位（优先锁定行）。 */
  id?: number
  source?: string
  /** 新译文；缺省则只改类别。 */
  target?: string
  category?: string
}

export interface TermsDeleteItem {
  id?: number
  /** 缺省 id 时按 source 删除该源词的全部行（清理一源多行）。 */
  source?: string
}

/** engineBackend=ts：按 id/source 原地更新术语译文/类别（S10：不新增行、避免一源两锁）。 */
export function runTsUpdate(config: Config, items: TermsUpdateItem[]): Tav2TermsResult {
  const knowledge = openKnowledge(config)
  try {
    let updated = 0
    for (const it of items) {
      let id = typeof it.id === 'number' ? it.id : -1
      if (id < 0 && it.source) id = knowledge.db.termIdBySource(it.source) ?? -1
      if (id < 0) continue
      if (knowledge.db.updateTerm(id, it.target ?? null, it.category ?? null)) updated += 1
    }
    return { ...tsKnowledgeResult(`已更新 ${updated} 条术语。`), terms: { updated } }
  } catch (err) {
    return tsKnowledgeResult(`术语更新失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

/** engineBackend=ts：删除术语（按 id 一行，或按 source 全部行）（S10）。 */
export function runTsDelete(config: Config, items: TermsDeleteItem[]): Tav2TermsResult {
  const knowledge = openKnowledge(config)
  try {
    let deleted = 0
    for (const it of items) {
      if (typeof it.id === 'number') {
        if (knowledge.db.deleteTerm(it.id)) deleted += 1
      } else if (it.source) {
        deleted += knowledge.db.deleteTermsBySource(it.source)
      }
    }
    return { ...tsKnowledgeResult(`已删除 ${deleted} 条术语。`), terms: { deleted } }
  } catch (err) {
    return tsKnowledgeResult(`术语删除失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

/** engineBackend=ts：列出术语（含 id/status/confidence），供 update/delete 定位。 */
export function runTsList(config: Config, status?: string): Tav2TermsResult {
  const knowledge = openKnowledge(config)
  try {
    const rows = knowledge.db.allTerms(status && status !== 'all' ? status : null)
    const items = rows.map((r) => ({
      id: Number(r.id),
      source: String(r.source ?? ''),
      target: String(r.target ?? ''),
      category: String(r.category ?? ''),
      status: String(r.status ?? ''),
      confidence: String(r.confidence ?? ''),
    }))
    const text = items.length
      ? items.map((t) => `#${t.id} [${t.status}/${t.confidence}] ${t.source} → ${t.target}${t.category ? `（${t.category}）` : ''}`).join('\n')
      : '（无术语）'
    return { ...tsKnowledgeResult(text), terms: { items } }
  } catch (err) {
    return tsKnowledgeResult(`术语列表失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

export function registerTermsTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_terms',
    description: '术语管理：扫描候选；apply 批量锁定；update 按 id/source 原地改译名（避免一源两锁）；'
      + 'delete 按 id/source 删除；list 列出（含 id）。写操作均需审批。',
    parameters: {
      apply: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            category: { type: 'string' },
          },
          additionalProperties: false,
        },
        description: '要锁定的术语列表 [{source,target,category?}, ...]；省略则只扫描候选',
      },
      list: {
        type: 'boolean',
        description: '列出术语（含 id/status/confidence），配合 update/delete 定位',
      },
      status: {
        type: 'string',
        enum: ['all', 'candidate', 'locked', 'rejected'],
        description: 'list 时的过滤条件（默认 all）',
      },
      update: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            source: { type: 'string' },
            target: { type: 'string' },
            category: { type: 'string' },
          },
          additionalProperties: false,
        },
        description: '更新术语译文/类别：[{id?, source?, target?, category?}]；按 id 定位，缺省按 source'
          + '（优先锁定行）——原地更新不新增行，避免一源两锁',
      },
      delete: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            source: { type: 'string' },
          },
          additionalProperties: false,
        },
        description: '删除术语：[{id?} | {source?}]；有 id 删一行，否则按 source 删全部行',
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
          terms: {
            type: 'object',
            description: '结构化术语结果（engineBackend=ts 时返回）',
            properties: {
              scanned: { type: 'number' },
              seeded: { type: 'number' },
              locked: { type: 'number' },
              updated: { type: 'number' },
              deleted: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    source: { type: 'string' },
                    target: { type: 'string' },
                    category: { type: 'string' },
                    status: { type: 'string' },
                    confidence: { type: 'string' },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2TermsResult) => {
        const head = value.ok ? '术语操作完成' : '术语操作失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => termsMeta(_args, value),
    },
    async execute(args, exec) {
      const items = (args.apply ?? []) as TermsApplyItem[]
      const updates = (args.update ?? []) as TermsUpdateItem[]
      const deletes = (args.delete ?? []) as TermsDeleteItem[]
      const list = args.list === true
      const hasWrites = items.length + updates.length + deletes.length > 0

      // 纯扫描（无任何动作参数）
      if (!hasWrites && !list) {
        if (config.engineBackend !== 'python') return runTsScan(ctx, config)
        const result = await runTav2({ config, args: ['terms'], signal: exec.signal })
        return resultToTool(result)
      }

      // 写操作统一审批（apply/update/delete）
      if (hasWrites) {
        const decision = await requestApproval(
          ctx,
          exec,
          `术语写操作：锁定 ${items.length} / 更新 ${updates.length} / 删除 ${deletes.length} 条（写项目知识库）`,
        )
        if (decision !== 'allowed') {
          return { ok: false, command: '', text: approvalDenialText(decision), timedOut: false }
        }
      }

      // apply 在 python 后端走子进程（与其他动作互斥时直接返回）
      if (items.length > 0 && config.engineBackend === 'python') {
        const dir = await mkdtemp(join(tmpdir(), 'tav2-terms-'))
        const jsonPath = join(dir, 'apply.json')
        try {
          await writeFile(
            jsonPath,
            JSON.stringify(items.map((t) => [t.source, t.target, t.category ?? ''])),
            'utf8',
          )
          const result = await runTav2({
            config,
            args: ['terms', '--apply', jsonPath],
            signal: exec.signal,
          })
          return resultToTool(result)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }

      const outputs: Tav2TermsResult[] = []
      if (items.length > 0) outputs.push(runTsApply(config, items))
      if (updates.length > 0) outputs.push(runTsUpdate(config, updates))
      if (deletes.length > 0) outputs.push(runTsDelete(config, deletes))
      if (list) outputs.push(runTsList(config, typeof args.status === 'string' ? args.status : undefined))

      return outputs.reduce<Tav2TermsResult>((acc, r) => ({
        ok: acc.ok && r.ok,
        command: r.command,
        text: [acc.text, r.text].filter(Boolean).join('\n'),
        timedOut: acc.timedOut || r.timedOut,
        terms: { ...acc.terms, ...r.terms },
      }), { ok: true, command: '', text: '', timedOut: false })
    },
  }))
}
