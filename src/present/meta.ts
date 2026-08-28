/**
 * 面板展示投影（G11）：把 tav2_* 工具的 structured output 投影为面板渲染用 JSON。
 * 纯函数：只读 value，不抛错（脏输入降级为空字段），键名与工具现有输出逐字一致。
 * 消费端：output.presentationMeta（随会话日志持久化，客户端经 ToolResultNode.meta 读取）。
 */
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** 窄化任意输入为可安全读取的记录对象。 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function boolean(value: unknown): boolean {
  return value === true
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** tav2_status 投影：项目总览字段。 */
export function statusMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const status = record(result.status)
  const fp = record(status.fingerprint)
  return {
    ok: boolean(result.ok),
    engine: string(status.engine),
    pluginVersion: string(status.pluginVersion),
    pluginSource: string(status.pluginSource),
    scenes: number(status.scenes),
    units: number(status.units),
    pendingUnits: number(status.pendingUnits),
    lockedTerms: number(status.lockedTerms),
    pendingTerms: number(status.pendingTerms),
    worldbookEntries: number(status.worldbookEntries),
    worldbookProposed: number(status.worldbookProposed),
    pendingApprovals: number(status.pendingApprovals),
    complianceStatus: string(status.complianceStatus),
    complianceAuthorized: boolean(status.complianceAuthorized),
    publicReleaseAllowed: boolean(status.publicReleaseAllowed),
    translationChannel: string(status.translationChannel),
    fingerprint: {
      engine: string(fp.engine),
      displayVersion: string(fp.displayVersion),
      fingerprint: string(fp.fingerprint),
      snapshotFingerprint: string(fp.snapshotFingerprint),
      hasSnapshot: boolean(fp.hasSnapshot),
      changed: boolean(fp.changed),
    },
    summary: string(status.summary),
  }
}

/** tav2_report 投影：覆盖率 / 风险 / 审校队列 / 成本 / 合规。 */
export function reportMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const report = record(result.report)
  const coverage = record(report.coverage)
  const risks = record(report.risks)
  const reviewQueue = record(report.reviewQueue)
  const cost = record(report.cost)
  const compliance = record(report.compliance)
  const byScene = Array.isArray(coverage.byScene)
    ? (coverage.byScene as unknown[]).map((row) => {
      const scene = record(row)
      return {
        sceneId: string(scene.sceneId),
        title: string(scene.title),
        units: number(scene.units),
        translated: number(scene.translated),
        pending: number(scene.pending),
      }
    })
    : []
  const approvals = Array.isArray(reviewQueue.approvals) ? reviewQueue.approvals.length : 0
  const recentRuns = Array.isArray(cost.recentRuns)
    ? (cost.recentRuns as unknown[]).map((row) => {
      const run = record(row)
      return {
        runId: string(run.runId),
        kind: string(run.kind),
        status: string(run.status),
        summary: string(run.summary),
        startedAt: string(run.startedAt),
        finishedAt: string(run.finishedAt),
      }
    })
    : []
  return {
    ok: boolean(result.ok),
    engine: string(report.engine),
    lang: string(report.lang),
    scenes: number(coverage.scenes),
    units: number(coverage.units),
    translated: number(coverage.translated),
    pending: number(coverage.pending),
    coveragePct: number(coverage.coveragePct),
    byScene,
    risks: {
      pendingTerms: number(risks.pendingTerms),
      lowConfidenceTerms: number(risks.lowConfidenceTerms),
    },
    reviewQueue: {
      pendingApprovals: number(reviewQueue.pendingApprovals),
      pendingProposals: number(reviewQueue.pendingProposals),
      approvals,
    },
    runs: number(cost.runs),
    calls: number(cost.calls),
    promptTokens: number(cost.promptTokens),
    completionTokens: number(cost.completionTokens),
    totalTokens: number(cost.totalTokens),
    elapsedSeconds: number(cost.elapsedSeconds),
    recentRuns,
    compliance: {
      status: string(compliance.status),
      authorized: boolean(compliance.authorized),
      publicReleaseAllowed: boolean(compliance.publicReleaseAllowed),
    },
  }
}

/** tav2_terms 投影：扫描/入库/锁定计数。 */
export function termsMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const terms = record(result.terms)
  return {
    ok: boolean(result.ok),
    scanned: number(terms.scanned),
    seeded: number(terms.seeded),
    locked: number(terms.locked),
  }
}

/** tav2_worldbook 投影：条目/提名统计/覆盖率/告警。 */
export function worldbookMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const worldbook = record(result.worldbook)
  const nominations = record(worldbook.nominations)
  return {
    ok: boolean(result.ok),
    entries: number(worldbook.entries),
    constants: number(worldbook.constants),
    filesReferenced: number(worldbook.filesReferenced),
    fileCoverage: number(worldbook.fileCoverage),
    warnings: stringArray(worldbook.warnings),
    nominations: {
      total: number(nominations.total),
      recommended: number(nominations.recommended),
      sedimented: number(nominations.sedimented),
      accepted: number(nominations.accepted),
      dismissed: number(nominations.dismissed),
      errors: stringArray(nominations.errors),
    },
  }
}

/** tav2_deliberate 投影：推敲统计。 */
export function deliberateMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const deliberation = record(result.deliberation)
  return {
    ok: boolean(result.ok),
    evaluated: number(deliberation.evaluated),
    auto_locked: number(deliberation.auto_locked),
    pending_approval: number(deliberation.pending_approval),
    failed: number(deliberation.failed),
  }
}

/** tav2_verify 投影：格式 / 覆盖 / 字体 / 指引。 */
export function verifyMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const verify = record(result.verify)
  const format = record(verify.format)
  const coverage = record(verify.coverage)
  const fonts = record(verify.fonts)
  return {
    ok: boolean(result.ok),
    engine: string(verify.engine),
    format: {
      missingBlocks: number(format.missingBlocks),
      tagViolations: number(format.tagViolations),
      engineNote: string(format.engineNote),
    },
    extractedUnits: number(coverage.extractedUnits),
    translatedUnits: number(coverage.translatedUnits),
    missingUnits: number(coverage.missingUnits),
    fonts: {
      checked: boolean(fonts.checked),
      found: boolean(fonts.found),
      warnings: stringArray(fonts.warnings),
    },
    guide: string(verify.guide),
  }
}

/** 后台任务工具（tav2_prepare / tav2_translate_batch / tav2_review_backfill）投影：任务句柄；前台降级附 ok/text。 */
export function jobMeta(_args: unknown, value: unknown): JsonValue {
  const result = record(value)
  const base = {
    kind: string(result.kind),
    jobId: string(result.jobId),
    label: string(result.label),
  }
  if (base.kind === 'foreground') {
    return {
      ...base,
      ok: boolean(result.ok),
      text: string(result.text),
      timedOut: boolean(result.timedOut),
    }
  }
  return base
}
