import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { extractCharacters } from '../engine/adapters/renpy/characters'
import { findOccurrences, type ScanCandidate } from '../engine/scanning'
import { coverageReport } from '../engine/worldbook'
import { generateWorldbookByTerms, type WorldbookSeed } from '../engine/worldbookTerms'
import {
  buildScanNominees,
  nomineeKey,
  recommendScanNominees,
  sedimentNominees,
  type Nominee,
} from '../engine/worldbookNominate'
import { worldbookMeta } from '../present/meta'
import { openKnowledge, sourceFileCount, tsGenerate, tsKnowledgeResult } from './tsKnowledge'

/** tav2_worldbook 参数：提名制工作流。 */
export interface WorldbookArgs {
  /** 本次最多提名的候选个数（不传=全部）。 */
  limit?: number
  /** 只提名指定 source（精确匹配）。 */
  terms?: string[]
  /** 强制重跑：已 dismiss 的提名重新进入候选（默认不再提名）。 */
  force?: boolean
  /** 接受提名：为这些提名 id 生成卡片草案（proposed，仍需 tav2_worldbook_edit confirm）。 */
  accept?: number[]
  /** 驳回提名：这些提名 id 标 dismissed，重跑不再提名。 */
  dismiss?: number[]
}

/** 提名统计（前端面板阶段 A 用）。 */
export interface Tav2WorldbookNominations {
  total: number
  recommended: number
  sedimented: number
  accepted: number
  dismissed: number
  errors: string[]
}

/** tav2_worldbook 的结构化结果（engineBackend=ts 时返回 worldbook）。 */
export interface Tav2WorldbookResult extends Tav2ToolResult {
  worldbook?: {
    entries: number
    constants: number
    filesReferenced: number
    fileCoverage: number
    warnings: string[]
    nominations?: Tav2WorldbookNominations
  }
}

/** 按原文行统计出现位置/频次，构造扫描候选（候选只来自已进入流程的术语 + 专名白名单）。 */
function seedCandidate(source: string, lines: string[]): ScanCandidate {
  const positions = findOccurrences(lines, source)
  return { source, kind: 'name', frequency: positions.length, positions, samples: [] }
}

/** 世界书 DB 内 active 条目数（proposed+confirmed，不含软删）。 */
function activeEntryCount(opened: ReturnType<typeof openKnowledge>): number {
  return opened.db.listWorldbook()
    .filter((e) => Number(e.active ?? 1) === 1 && String(e.status) !== 'rejected').length
}

/** 接受提名：为每个提名词生成卡片草案（proposed，仍需 confirm）。 */
async function acceptNominations(
  ctx: Context,
  config: Config,
  opened: ReturnType<typeof openKnowledge>,
  ids: number[],
): Promise<{ report: string[]; constants: number; accepted: number }> {
  const { db, engineCfg, scanLines: lines } = opened
  const report: string[] = []
  const rows = db.getNominations(ids).filter((n) => String(n.status) !== 'dismissed')
  if (rows.length === 0) {
    report.push('没有可接受的提名（id 不存在或已驳回）。')
    return { report, constants: 0, accepted: 0 }
  }
  const lockedMap = new Map(db.lockedTerms().map((t) => [String(t.source), String(t.target)]))
  const seeds: WorldbookSeed[] = rows.map((n) => {
    const source = String(n.source)
    const positions = findOccurrences(lines, source)
    return {
      source,
      kind: String(n.kind) === 'name' ? 'character' : 'term',
      frequency: positions.length,
      positions,
      lockedTarget: lockedMap.get(source) ?? '',
      priority: String(n.kind) === 'name' ? 0 : 1,
    }
  })
  const extraContext = new Map<string, string>()
  for (const n of rows) {
    const hint = String(n.hint ?? '').trim()
    const scenes = Array.isArray(n.scenes) ? (n.scenes as string[]) : []
    if (hint || scenes.length > 0) {
      extraContext.set(String(n.source),
        `背景线索（理解沉淀）：${hint || '（无）'}`
        + (scenes.length > 0 ? `（支撑场景：${scenes.join('、')}）` : ''))
    }
  }
  report.push(`接受 ${seeds.length} 个提名，生成卡片草案……`)
  const gen = await generateWorldbookByTerms({
    generate: await tsGenerate(ctx, config, engineCfg),
    cfg: engineCfg,
    lines,
    seeds,
    extraContext,
  })
  const proposed = db.proposeWorldbookByTerm(
    gen.pending.map((p) => ({ ...p.entry, linked_term: p.seedSource })),
  )
  db.setNominationStatus(rows.map((n) => Number(n.id)), 'accepted')
  report.push(`  - 出卡/更新 ${proposed} 张（常驻 ${gen.constants} 张），状态 proposed，待 tav2_worldbook_edit confirm`)
  const noinfo = gen.outcomes.filter((o) => o.status === 'noinfo').map((o) => o.source)
  if (noinfo.length > 0) report.push(`  - 没料 ${noinfo.length} 个：${noinfo.join('、')}（可 worldbook_edit add 人工补充）`)
  for (const err of gen.errors) report.push(`  [失败] ${err}`)
  return { report, constants: gen.constants, accepted: rows.length }
}

/** engineBackend=ts：世界书提名制主流程。 */
export async function runTsWorldbook(
  ctx: Context,
  config: Config,
  args: WorldbookArgs = {},
): Promise<Tav2WorldbookResult> {
  const knowledge = openKnowledge(config)
  try {
    const { db, engineCfg, scanLines: lines } = knowledge
    if (lines.length === 0) {
      return tsKnowledgeResult('未找到可扫描的原文行。', false)
    }
    const report: string[] = []

    // 写操作分支：accept 出卡 / dismiss 驳回（均只是提名记账与草案，终态仍走 edit confirm 审批）。
    if (args.accept && args.accept.length > 0) {
      const r = await acceptNominations(ctx, config, knowledge, args.accept)
      report.push(...r.report)
      return {
        ...tsKnowledgeResult(report.join('\n')),
        worldbook: {
          entries: activeEntryCount(knowledge),
          constants: r.constants,
          filesReferenced: 0,
          fileCoverage: 0,
          warnings: [],
          nominations: {
            total: 0, recommended: 0, sedimented: 0,
            accepted: r.accepted, dismissed: 0, errors: [],
          },
        },
      }
    }
    if (args.dismiss && args.dismiss.length > 0) {
      const affected = db.setNominationStatus(args.dismiss, 'dismissed')
      report.push(`已驳回 ${affected} 个提名（重跑不再提名；force 可恢复）。`)
    }

    // ---- 提名流程：词表通道 + 理解沉淀通道 → 三问推荐 → 落库待 accept ----
    const engaged = db.engagedWorldbookTerms()
    const properNouns = engineCfg.scan.extraProperNouns ?? []
    const characters = engineCfg.engine === 'renpy'
      ? extractCharacters(engineCfg.gameDir)
      : new Map<string, string>()
    const candidates: ScanCandidate[] = [
      ...engaged.map((t) => seedCandidate(String(t.source), lines)),
      ...properNouns.map((w) => seedCandidate(w, lines)),
    ]

    // 跳过集：术语 skip 终态（仅锁译名永不出卡，含角色/白名单来源）+ 已 dismiss 的提名。
    // force=重新提名：dismissed 不再拦截（upsert 会把重提名的 dismissed 行复活回 nominated）。
    const skipKeys = new Set<string>()
    if (args.force !== true) {
      for (const k of db.dismissedNominationKeys()) skipKeys.add(k)
      for (const source of db.skipWorldbookTermSources()) skipKeys.add(nomineeKey(source))
    }

    let nominees = buildScanNominees({ characters, candidates, lines, cfg: engineCfg, skipKeys })
    if (args.terms && args.terms.length > 0) {
      const whitelist = new Set(args.terms.map((t) => nomineeKey(t)).filter(Boolean))
      nominees = nominees.filter((n) => whitelist.has(nomineeKey(n.source)))
    }
    if (args.limit && args.limit > 0) nominees = nominees.slice(0, Math.floor(args.limit))
    report.push(
      `扫描 ${lines.length} 行原文：词表通道提名 ${nominees.length} 个`
      + `（跨度阈值 ${engineCfg.worldbook.minSpread}，低于它的集中爆发的词已硬淘汰）。`,
    )

    // 理解沉淀通道：从场景理解记录提取设定级实体（提取+三问一步完成）。
    let sedimented: Nominee[] = []
    const errors: string[] = []
    const understandingRows = db.allUnderstandings()
    if (engineCfg.worldbook.sediment) {
      const sed = await sedimentNominees(await tsGenerate(ctx, config, engineCfg), engineCfg, understandingRows)
      sedimented = sed.nominees
      errors.push(...sed.errors)
      report.push(`理解沉淀通道：从 ${understandingRows.length} 条场景理解中提名 ${sedimented.length} 个设定级实体。`)
    }

    // 词表通道的三问推荐（推荐而非闸门：失败时保留全部提名供人工判断）。
    if (nominees.length > 0) {
      const rec = await recommendScanNominees(await tsGenerate(ctx, config, engineCfg), engineCfg, nominees)
      errors.push(...rec.errors)
    }

    // 合并：同 key 的沉淀实体把背景线索并入词表提名，避免重复出卡。
    const sedByKey = new Map(sedimented.map((n) => [nomineeKey(n.source), n]))
    const merged: Nominee[] = []
    const mergedKeys = new Set<string>()
    for (const n of nominees) {
      const key = nomineeKey(n.source)
      mergedKeys.add(key)
      const sed = sedByKey.get(key)
      if (sed) {
        n.hint = sed.hint
        n.scenes = sed.scenes
        if (!n.recommended && sed.recommended) {
          n.recommended = true
          n.reason = n.reason ? `${n.reason}；${sed.reason}` : sed.reason
        }
      }
      merged.push(n)
    }
    for (const sed of sedimented) {
      if (!mergedKeys.has(nomineeKey(sed.source))) merged.push(sed)
    }

    for (const n of merged) {
      if (args.force === true) {
        // force=重新提名：把重新出现的 dismissed 行复活回 nominated（用户显式要求重评）。
        db.reviveNomination(n.source)
      }
      db.upsertNomination({
        source: n.source, origin: n.origin, kind: n.kind, frequency: n.frequency,
        spread: n.spread, files: n.files, evidence: n.evidence, scenes: n.scenes,
        hint: n.hint, reason: n.reason, recommended: n.recommended,
      })
    }

    const stored = db.listNominations('nominated')
    const recommendedRows = stored.filter((n) => n.recommended === true)
    const watchRows = stored.filter((n) => n.recommended !== true)
    report.push(`提名完成：推荐出卡 ${recommendedRows.length} 个，观察 ${watchRows.length} 个（详见下方清单）。`)
    for (const n of recommendedRows) {
      report.push(`  [推荐 #${n.id}] ${String(n.source)}（${String(n.kind)}，跨度 ${Number(n.spread).toFixed(2)}，`
        + `出现 ${Number(n.frequency)} 次）${String(n.reason ?? '')}`)
    }
    for (const n of watchRows) {
      report.push(`  [观察 #${n.id}] ${String(n.source)}（跨度 ${Number(n.spread).toFixed(2)}，出现 ${Number(n.frequency)} 次）`
        + `${String(n.reason ?? '')}`)
    }
    const acceptCount = db.listNominations('accepted').length
    const dismissCount = db.listNominations('dismissed').length
    if (stored.length > 0) {
      report.push('用 accept=<提名id> 接受（生成卡片草案，仍需 confirm）；dismiss=<提名id> 驳回。')
    }
    if (acceptCount > 0) report.push(`已接受待出卡 ${acceptCount} 个；已驳回 ${dismissCount} 个。`)
    for (const err of errors) report.push(`  [失败] ${err}`)

    const coverage = coverageReport(
      db.loadWorldbook().map((e) => ({ source_refs: e.source_refs })),
      knowledge.scanLines.length > 0 ? sourceFileCount(knowledge.scanLines) : 0,
      knowledge.scanLines.length,
    )
    for (const warning of coverage.warnings) report.push(`  [覆盖率告警] ${warning}`)

    return {
      ...tsKnowledgeResult(report.join('\n')),
      worldbook: {
        entries: activeEntryCount(knowledge),
        constants: 0,
        filesReferenced: coverage.files_referenced,
        fileCoverage: coverage.file_coverage,
        warnings: coverage.warnings,
        nominations: {
          total: stored.length,
          recommended: recommendedRows.length,
          sedimented: sedimented.length,
          accepted: acceptCount,
          dismissed: dismissCount,
          errors: errors.slice(0, 3),
        },
      },
    }
  } catch (err) {
    return tsKnowledgeResult(`世界书生成失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

export function registerWorldbookTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_worldbook',
    description: '世界书提名制：聚合证据并按三问判据推荐「设定级实体」，用户 accept 后才出卡草案（confirm 仍需审批）；支持理解沉淀通道提取规则/关系类设定。',
    parameters: {
      limit: {
        type: 'number',
        description: '本次最多提名的候选个数（不传=全部）',
      },
      terms: {
        type: 'array',
        items: { type: 'string' },
        description: '只提名指定的 source（精确匹配）',
      },
      force: {
        type: 'boolean',
        description: '强制重跑：已 dismiss 的提名重新进入候选',
      },
      accept: {
        type: 'array',
        items: { type: 'number' },
        description: '接受提名 id 列表：生成卡片草案（proposed，仍需 tav2_worldbook_edit confirm）',
      },
      dismiss: {
        type: 'array',
        items: { type: 'number' },
        description: '驳回提名 id 列表：标 dismissed，重跑不再提名',
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
          worldbook: {
            type: 'object',
            description: '结构化世界书结果（engineBackend=ts 时返回）',
            properties: {
              entries: { type: 'number' },
              constants: { type: 'number' },
              filesReferenced: { type: 'number' },
              fileCoverage: { type: 'number' },
              warnings: { type: 'array', items: { type: 'string' } },
              nominations: {
                type: 'object',
                description: '提名统计',
                properties: {
                  total: { type: 'number' },
                  recommended: { type: 'number' },
                  sedimented: { type: 'number' },
                  accepted: { type: 'number' },
                  dismissed: { type: 'number' },
                  errors: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2WorldbookResult) => {
        const head = value.ok ? '世界书提名完成' : '世界书处理失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => worldbookMeta(_args, value),
    },
    async execute(args: WorldbookArgs, exec) {
      if (config.engineBackend !== 'python') return runTsWorldbook(ctx, config, args)
      const result = await runTav2({ config, args: ['worldbook'], signal: exec.signal })
      return resultToTool(result)
    },
  }))
}
