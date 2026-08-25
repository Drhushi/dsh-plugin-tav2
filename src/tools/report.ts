/**
 * tav2_report：翻译项目报表（覆盖率 / 质量风险 / 审校队列 / 成本）。
 * 对应施工规划 §6 的 tx_report 与 HANDOFF 前端阶段 C 的数据来源；
 * 输出结构化报表，Web GUI 可直接渲染，文本保持人类可读。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { verifyRenpy } from '../engine/adapters/renpy/verify'
import { renpyAdapter } from '../engine/adapters'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'
import { tsKnowledgeResult } from './tsKnowledge'
import { reportMeta } from '../present/meta'

/** 报表的覆盖率段。 */
export interface ReportCoverageScene {
  sceneId: string
  title: string
  units: number
  translated: number
  pending: number
}

export interface ReportCoverage {
  scenes: number
  units: number
  translated: number
  pending: number
  /** 已译单元占比（0–100，四舍五入） */
  coveragePct: number
  byScene: ReportCoverageScene[]
}

/** 报表的质量风险段（G0 格式 / 术语）。 */
export interface ReportRisks {
  /** G0 校验结果；非 renpy 引擎或校验失败时省略该字段 */
  g0?: { missingBlocks: number; tagViolations: number }
  pendingTerms: number
  lowConfidenceTerms: number
}

/** 报表的审校队列段。 */
export interface ReportReviewQueue {
  pendingApprovals: number
  pendingProposals: number
  approvals: Array<{ id: number; kind: string; status: string; createdAt: string }>
}

/** 报表的成本段。 */
export interface ReportCost {
  runs: number
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  elapsedSeconds: number
  recentRuns: Array<{ runId: string; kind: string; status: string; summary: string; startedAt: string; finishedAt: string }>
}

/** tav2_report 的结构化结果。 */
export interface Tav2ReportResult extends Tav2ToolResult {
  report?: {
    engine: string
    lang: string
    coverage: ReportCoverage
    risks: ReportRisks
    reviewQueue: ReportReviewQueue
    cost: ReportCost
    compliance: { status: string; authorized: boolean; publicReleaseAllowed: boolean }
  }
}

/** engineBackend=ts：聚合项目报表（仅 Ren'Py）。 */
export function runTsReport(config: Config): Tav2ReportResult {
  if (config.engineBackend === 'python') {
    return {
      ok: false,
      command: '',
      text: 'engineBackend=python：tav2_report 仅 TS 后端支持（Python 基线无 report 命令），请改用 engineBackend=ts。',
      timedOut: false,
    }
  }

  let db: ProjectDB | null = null
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (!engineCfg.gameDir) {
      return tsKnowledgeResult('报表生成失败：config.yaml 未配置 game_dir', false)
    }

    // 提取文档（覆盖率骨架）；DB 提供翻译状态（真相源）。
    const document = renpyAdapter.extract(engineCfg.gameDir, { lang: engineCfg.lang }).document

    db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
    const projectDb = db
    const byScene: ReportCoverageScene[] = document.scenes.map((scene) => {
      let translated = 0
      let pending = 0
      for (const unit of scene.units) {
        const status = projectDb.unitStatus(unit.unit_id)
        if (status === 'translated') translated += 1
        else if (status === 'pending') pending += 1
      }
      return {
        sceneId: scene.scene_id,
        title: scene.title,
        units: scene.units.length,
        translated,
        pending,
      }
    })
    const coverage: ReportCoverage = {
      scenes: document.scenes.length,
      units: document.allUnits().length,
      translated: byScene.reduce((sum, s) => sum + s.translated, 0),
      pending: byScene.reduce((sum, s) => sum + s.pending, 0),
      coveragePct: 0,
      byScene,
    }
    coverage.coveragePct = coverage.units > 0
      ? Math.round((coverage.translated / coverage.units) * 100)
      : 0

    // G0 格式校验仅 renpy 引擎可用；失败或不可用则省略该字段（不阻断报表）。
    let g0: ReportRisks['g0']
    if (engineCfg.engine === 'renpy' && engineCfg.gameDir) {
      try {
        const report = verifyRenpy(engineCfg.gameDir, engineCfg.lang)
        g0 = { missingBlocks: report.missing_blocks, tagViolations: report.tag_violations }
      } catch {
        g0 = undefined
      }
    }

    const pendingTerms = db.pendingTerms()
    const risks: ReportRisks = {
      ...(g0 ? { g0 } : {}),
      pendingTerms: pendingTerms.length,
      lowConfidenceTerms: pendingTerms.filter((t) => String(t.confidence ?? '') === 'low').length,
    }

    const pendingApprovals = db.pendingApprovals()
    const reviewQueue: ReportReviewQueue = {
      pendingApprovals: pendingApprovals.length,
      pendingProposals: db.pendingProposals().length,
      approvals: pendingApprovals.map((a) => ({
        id: Number(a.id),
        kind: String(a.kind ?? ''),
        status: String(a.status ?? ''),
        createdAt: String(a.createdAt ?? ''),
      })),
    }

    const totals = db.usageTotals()
    const cost: ReportCost = {
      runs: totals.runs,
      calls: totals.calls,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      elapsedSeconds: totals.elapsedSeconds,
      recentRuns: db.recentRuns(5).map((r) => ({
        runId: String(r.run_id ?? ''),
        kind: String(r.kind ?? ''),
        status: String(r.status ?? ''),
        summary: String(r.summary ?? ''),
        startedAt: String(r.started_at ?? ''),
        finishedAt: String(r.finished_at ?? ''),
      })),
    }

    const record = db.getCompliance()
    const compliance = {
      status: record.status,
      authorized: record.authorized === true,
      publicReleaseAllowed: db.isPublicReleaseAllowed(),
    }

    const g0Label = g0 === undefined
      ? '不可用（仅 renpy 引擎）'
      : `缺失块 ${g0.missingBlocks} / 标签违规 ${g0.tagViolations}`
    // S3：0 提取单元 ≠ 正常——明确标「未初始化」，避免被误读为「全绿」。
    const uninitialized = coverage.units === 0
    const text = [
      ...(uninitialized ? ['⚠️ 项目未初始化/无提取单元（0 场景 / 0 单元），请先 tav2_prepare 提取'] : []),
      `引擎：${engineCfg.engine} / ${engineCfg.lang}  场景：${coverage.scenes}`,
      `覆盖率：${coverage.units} 单元，已译 ${coverage.translated}（${coverage.coveragePct}%），待译 ${coverage.pending}`,
      `G0 格式：${g0Label}`,
      `术语：待决 ${risks.pendingTerms}（低置信 ${risks.lowConfidenceTerms}）`,
      `审校队列：待审批 ${reviewQueue.pendingApprovals}，待决提案 ${reviewQueue.pendingProposals}`,
      `成本：${cost.runs} 次运行 / ${cost.calls} 次调用 / ${cost.totalTokens} tokens / ${cost.elapsedSeconds}s`,
      `G-1 授权：${compliance.status}${compliance.publicReleaseAllowed ? '（可公开发布）' : '（仅本地自用）'}`,
    ].join('\n')
    return {
      ...tsKnowledgeResult(text),
      report: { engine: engineCfg.engine, lang: engineCfg.lang, coverage, risks, reviewQueue, cost, compliance },
    }
  } catch (err) {
    return tsKnowledgeResult(`报表生成失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    db?.close()
  }
}

export function registerReportTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_report',
    description: '生成翻译项目报表：覆盖率、质量风险（G0/术语）、审校队列、成本用量（engineBackend=ts）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          report: {
            type: 'object',
            description: '结构化报表（engineBackend=ts 时返回）',
            properties: {
              engine: { type: 'string' },
              lang: { type: 'string' },
              coverage: {
                type: 'object',
                properties: {
                  scenes: { type: 'number' },
                  units: { type: 'number' },
                  translated: { type: 'number' },
                  pending: { type: 'number' },
                  coveragePct: { type: 'number' },
                  byScene: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        sceneId: { type: 'string' },
                        title: { type: 'string' },
                        units: { type: 'number' },
                        translated: { type: 'number' },
                        pending: { type: 'number' },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
              risks: {
                type: 'object',
                properties: {
                  g0: {
                    type: 'object',
                    properties: {
                      missingBlocks: { type: 'number' },
                      tagViolations: { type: 'number' },
                    },
                    additionalProperties: false,
                  },
                  pendingTerms: { type: 'number' },
                  lowConfidenceTerms: { type: 'number' },
                },
                additionalProperties: false,
              },
              reviewQueue: {
                type: 'object',
                properties: {
                  pendingApprovals: { type: 'number' },
                  pendingProposals: { type: 'number' },
                  approvals: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'number' },
                        kind: { type: 'string' },
                        status: { type: 'string' },
                        createdAt: { type: 'string' },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
              cost: {
                type: 'object',
                properties: {
                  runs: { type: 'number' },
                  calls: { type: 'number' },
                  promptTokens: { type: 'number' },
                  completionTokens: { type: 'number' },
                  totalTokens: { type: 'number' },
                  elapsedSeconds: { type: 'number' },
                  recentRuns: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        runId: { type: 'string' },
                        kind: { type: 'string' },
                        status: { type: 'string' },
                        summary: { type: 'string' },
                        startedAt: { type: 'string' },
                        finishedAt: { type: 'string' },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
              compliance: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  authorized: { type: 'boolean' },
                  publicReleaseAllowed: { type: 'boolean' },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ReportResult) => {
        const head = value.ok ? 'tav2 报表' : 'tav2 报表生成失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => reportMeta(_args, value),
    },
    async execute(_args, _exec) {
      return runTsReport(config)
    },
  }))
}
