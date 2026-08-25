import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { extractCharacters } from '../engine/adapters/renpy/characters'
import { findOccurrences, type ScanCandidate } from '../engine/scanning'
import { coverageReport } from '../engine/worldbook'
import {
  buildWorldbookSeeds,
  generateWorldbookByTerms,
  type WorldbookSeed,
} from '../engine/worldbookTerms'
import { worldbookMeta } from '../present/meta'
import { openKnowledge, sourceFileCount, tsGenerate, tsKnowledgeResult } from './tsKnowledge'

/** tav2_worldbook 参数：部分执行 + 强制重跑。 */
export interface WorldbookArgs {
  /** 本次最多处理的术语个数（人名/锁定术语优先；不传=全部）。 */
  limit?: number
  /** 只处理指定 source 的术语（精确匹配）。 */
  terms?: string[]
  /** 强制重跑已处理（proposed/covered/noinfo）的术语。 */
  force?: boolean
}

/** 术语级覆盖统计（前端面板阶段 A 用）。 */
export interface Tav2WorldbookTerms {
  total: number
  processed: number
  skipped: number
  proposed: number
  noinfo: number
  error: number
  errors: string[]
  unmatched: string[]
}

/** tav2_worldbook 的结构化结果（engineBackend=ts 时返回 worldbook）。 */
export interface Tav2WorldbookResult extends Tav2ToolResult {
  worldbook?: {
    entries: number
    constants: number
    filesReferenced: number
    fileCoverage: number
    warnings: string[]
    terms?: Tav2WorldbookTerms
  }
}

/** 种子类别 → 术语表 category。 */
function categoryForSeed(kind: WorldbookSeed['kind']): string {
  return kind === 'character' || kind === 'name' || kind === 'allcaps' ? 'name' : 'term'
}

/** 按原文行统计出现位置/频次，构造扫描候选（方案 C：候选不再来自全量重扫）。 */
function seedCandidate(source: string, lines: string[]): ScanCandidate {
  const positions = findOccurrences(lines, source)
  return { source, kind: 'name', frequency: positions.length, positions, samples: [] }
}

/** engineBackend=ts：直接跑 TS 术语驱动世界书生成。 */
export async function runTsWorldbook(
  ctx: Context,
  config: Config,
  args: WorldbookArgs = {},
): Promise<Tav2WorldbookResult> {
  const knowledge = openKnowledge(config)
  try {
    const lines = knowledge.scanLines
    if (lines.length === 0) {
      return tsKnowledgeResult('未找到可扫描的原文行。', false)
    }
    const locked = knowledge.db.lockedTerms()
    const engaged = knowledge.db.engagedWorldbookTerms()
    const properNouns = knowledge.engineCfg.scan.extraProperNouns ?? []
    const characters = knowledge.engineCfg.engine === 'renpy'
      ? extractCharacters(knowledge.engineCfg.gameDir)
      : new Map<string, string>()

    // 方案 C：种子候选只吃「已进入世界书流程的术语 + 专名白名单」，不再重扫全量候选。
    // 已拒绝/删除（worldbook_status 清空或物理删除）与 skip 的术语不再重复出卡。
    const candidates: ScanCandidate[] = [
      ...engaged.map((t) => seedCandidate(String(t.source), lines)),
      ...properNouns.map((w) => seedCandidate(w, lines)),
    ]
    const lockedTerms = locked as Array<{ source: string; target: string }>
    let seeds = buildWorldbookSeeds({ characters, candidates, lockedTerms, lines })
    const report: string[] = []
    report.push(
      `扫描 ${lines.length} 行原文，术语种子共 ${seeds.length} 个`
      + `（人名 ${seeds.filter((s) => s.priority === 0).length}、`
      + `锁定 ${seeds.filter((s) => s.priority === 1).length}、`
      + `候选 ${seeds.filter((s) => s.priority === 2).length}）。`,
    )

    let unmatched: string[] = []
    if (args.terms && args.terms.length > 0) {
      const whitelist = new Set(args.terms.map((t) => t.trim()).filter(Boolean))
      const before = new Set(seeds.map((s) => s.source))
      unmatched = [...whitelist].filter((w) => !before.has(w))
      seeds = seeds.filter((s) => whitelist.has(s.source))
      if (unmatched.length > 0) report.push(`白名单未匹配任何种子：${unmatched.join('、')}`)
    }
    if (args.limit && args.limit > 0) seeds = seeds.slice(0, Math.floor(args.limit))

    // 确保每个种子在术语表有行，便于按名字记账。
    for (const s of seeds) knowledge.db.ensureTerm(s.source, categoryForSeed(s.kind))

    const force = args.force === true
    const toProcess: WorldbookSeed[] = []
    const skipped = new Set<string>()
    for (const s of seeds) {
      const status = knowledge.db.termWorldbookStatus(s.source)
      // skip 是显式终态（仅锁译名、永不出卡）：即使 force 也不再出卡。
      if (status === 'skip') {
        skipped.add(s.source)
      } else if (!force && (status === 'proposed' || status === 'covered' || status === 'noinfo')) {
        skipped.add(s.source)
      } else {
        toProcess.push(s)
      }
    }

    const gen = await generateWorldbookByTerms({
      generate: await tsGenerate(ctx, config, knowledge.engineCfg),
      cfg: knowledge.engineCfg,
      lines,
      seeds: toProcess,
      onProgress: (done, total) => report.push(`  [世界书] 处理 ${done}/${total}`),
    })

    const proposed = knowledge.db.proposeWorldbookByTerm(
      gen.pending.map((p) => ({ ...p.entry, linked_term: p.seedSource })),
    )
    for (const o of gen.outcomes) {
      if (o.status === 'noinfo') knowledge.db.setTermWorldbookStatus(o.source, 'noinfo')
      else if (o.status === 'error') knowledge.db.setTermWorldbookStatus(o.source, 'error')
    }

    const noinfoCount = gen.outcomes.filter((o) => o.status === 'noinfo').length
    const errorCount = gen.outcomes.filter((o) => o.status === 'error').length
    const skippedCount = skipped.size
    const processedCount = toProcess.length

    report.push(`本次处理 ${processedCount} 个，跳过 ${skippedCount} 个（已出草稿/已确认/没料）。`)
    report.push(`  - 新出卡/更新 ${proposed} 张（常驻 ${gen.constants} 张）`)
    report.push(`  - 没料 ${noinfoCount} 个`)
    report.push(`  - 失败 ${errorCount} 个`)
    for (const err of gen.errors) report.push(`    [失败] ${err}`)
    if (errorCount > 0) report.push('  失败的名字可用 terms=<名字> 定向重跑，或调 force 重试。')

    const coverage = coverageReport(
      gen.entries,
      sourceFileCount(knowledge.scanLines),
      knowledge.scanLines.length,
    )
    for (const warning of coverage.warnings) report.push(`  [覆盖率告警] ${warning}`)
    report.push(
      `覆盖率：条目 ${coverage.entries}，来源文件 ${coverage.source_files}，`
      + `引用文件 ${coverage.files_referenced}（${Math.round(coverage.file_coverage * 100)}%）`,
    )
    const pendingTotal = knowledge.db.listWorldbook('proposed').length
    report.push(`世界书提案完成：本次新增/更新 ${proposed} 条，累计待确认 ${pendingTotal} 条。`)
    report.push('用 tav2_worldbook_edit confirm <ids> 确认；update/delete 修改或删除；add 人工补充。')

    return {
      ...tsKnowledgeResult(report.join('\n')),
      worldbook: {
        entries: coverage.entries,
        constants: gen.constants,
        filesReferenced: coverage.files_referenced,
        fileCoverage: coverage.file_coverage,
        warnings: coverage.warnings,
        terms: {
          total: seeds.length,
          processed: processedCount,
          skipped: skippedCount,
          proposed,
          noinfo: noinfoCount,
          error: errorCount,
          errors: gen.errors,
          unmatched,
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
    description: '生成/更新世界书条目（按名字做资料卡：人名代码 + 锁定术语 + 快扫候选；只吃原版源文本）。',
    parameters: {
      limit: {
        type: 'number',
        description: '本次最多处理的术语个数（人名/锁定术语优先；不传=全部）',
      },
      terms: {
        type: 'array',
        items: { type: 'string' },
        description: '只处理指定的术语 source（精确匹配）',
      },
      force: {
        type: 'boolean',
        description: '强制重跑已处理（已出草稿/已确认/没料）的术语',
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
              terms: {
                type: 'object',
                description: '术语级覆盖统计',
                properties: {
                  total: { type: 'number' },
                  processed: { type: 'number' },
                  skipped: { type: 'number' },
                  proposed: { type: 'number' },
                  noinfo: { type: 'number' },
                  error: { type: 'number' },
                  errors: { type: 'array', items: { type: 'string' } },
                  unmatched: { type: 'array', items: { type: 'string' } },
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
        const head = value.ok ? '世界书生成完成' : '世界书生成失败'
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
