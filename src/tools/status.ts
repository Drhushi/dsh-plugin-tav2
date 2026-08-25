import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { openKnowledge, tsKnowledgeResult } from './tsKnowledge'
import { describeChannelSync, mergeTranslationApi } from './translationApi'
import { modeStatePath, readStateApi } from '../mode'
import { renpyAdapter } from '../engine/adapters'
import type { RuntimeRequirement } from '../engine/adapters'
import { summarizeRuntime } from '../engine/runtime/summary'
import { computeGameFingerprint, fingerprintChanged, readFingerprintSnapshot } from '../core/fingerprint'
import { statusMeta } from '../present/meta'
import { pluginSource, pluginVersion } from '../version'

/** tav2_status 的结构化总览（前端阶段 A）。 */
export interface Tav2StatusSummary {
  fingerprint?: {
    engine: string
    displayVersion: string
    fingerprint: string
    snapshotFingerprint: string
    hasSnapshot: boolean
    changed: boolean
  }
  /** 当前加载的插件版本与模块来源（自检用：区分仓库/安装副本/新旧代码）。 */
  pluginVersion: string
  pluginSource: string
  engine: string
  scenes: number
  units: number
  pendingUnits: number
  lockedTerms: number
  pendingTerms: number
  worldbookEntries: number
  pendingApprovals: number
  complianceStatus: string
  complianceAuthorized: boolean
  publicReleaseAllowed: boolean
  /** 当前翻译通道（专用 API baseUrl/model 或 宿主 provider）。 */
  translationChannel: string
  /** 运行时自检：部署形态 + 伴侣组件安装状态 + 最近一次运行时层结论。 */
  runtime?: {
    mode: { kind: string; translationDir: string | null; note: string } | null
    requirements: RuntimeRequirement[]
    runtimeLayer: 'ok' | 'unverified' | 'warn' | 'fail'
  }
  summary: string
}

export interface Tav2StatusResult extends Tav2ToolResult {
  status?: Tav2StatusSummary
}

/** engineBackend=ts：从 TS 引擎读取项目状态。 */
export function runTsStatus(config: Config, statePath?: string): Tav2StatusResult {
  const knowledge = openKnowledge(config)
  try {
    // 状态展示用「合并后」的翻译通道（yaml 层 + 设置卡当前渠道的 state.json 层），
    // 与引擎实际生效的 perAgent.translationApi 一致；不给 statePath 时只看 yaml 层。
    const displayConfig = statePath
      ? { ...config, translationApi: mergeTranslationApi(config.translationApi, readStateApi(statePath)) }
      : config
    const units = knowledge.document.allUnits()
    const pending = units.filter((u) => !u.extra.translated)
    const summary = knowledge.db.getSummary('main')
    const compliance = knowledge.db.getCompliance()
    const publicReleaseAllowed = knowledge.db.isPublicReleaseAllowed()
    const status: Tav2StatusSummary = {
      engine: knowledge.document.engine,
      pluginVersion: pluginVersion(),
      pluginSource: pluginSource(),
      scenes: knowledge.document.scenes.length,
      units: units.length,
      pendingUnits: pending.length,
      lockedTerms: knowledge.db.lockedTerms().length,
      pendingTerms: knowledge.db.pendingTerms().length,
      worldbookEntries: knowledge.db.loadWorldbook().length,
      pendingApprovals: knowledge.db.pendingApprovals().length,
      complianceStatus: compliance.status,
      complianceAuthorized: compliance.authorized === true,
      publicReleaseAllowed,
      translationChannel: describeChannelSync(displayConfig, knowledge.engineCfg.llm.model),
      summary: summary.slice(0, 80),
    }

    const rtAdapter = renpyAdapter
    const rt = rtAdapter.runtime
    if (rt) {
      const summary = summarizeRuntime(rt, knowledge.engineCfg.gameDir, knowledge.engineCfg.lang, knowledge.engineCfg.runtime)
      status.runtime = { mode: summary.mode, requirements: summary.requirements, runtimeLayer: summary.runtimeLayer }
    }
    const complianceLabel = publicReleaseAllowed
      ? '已授权可公开发布'
      : `未授权（仅本地自用）`
    let fingerprintLine = ''
    let fingerprintView: NonNullable<Tav2StatusSummary['fingerprint']> | undefined
    try {
      const cur = computeGameFingerprint(knowledge.engineCfg.engine, knowledge.engineCfg.gameDir)
      const snap = readFingerprintSnapshot(knowledge.db)
      const changed = snap ? fingerprintChanged(snap, cur) : false
      fingerprintView = {
        engine: cur.engine,
        displayVersion: cur.displayVersion,
        fingerprint: cur.fingerprint,
        snapshotFingerprint: snap?.fingerprint ?? '',
        hasSnapshot: Boolean(snap),
        changed,
      }
      if (!snap) fingerprintLine = '版本指纹：未建立快照（建议 tav2_fingerprint snapshot）'
      else if (changed) fingerprintLine = `⚠️ 版本指纹变化：游戏源文件可能已更新（快照 ${snap!.fingerprint.slice(0, 12)}… → 当前 ${cur.fingerprint.slice(0, 12)}…）`
      else fingerprintLine = `版本指纹：${cur.fingerprint.slice(0, 12)}…（源文件未变）`
    } catch {
      fingerprintLine = ''
    }
    if (fingerprintView) status.fingerprint = fingerprintView
    const text = [
      `引擎：${status.engine}`,
      `插件：v${status.pluginVersion}（${status.pluginSource}）`,
      `项目 DB：${knowledge.db.path}`,
      `场景：${status.scenes}  单元：${status.units}  待译：${status.pendingUnits}`,
      `锁定术语：${status.lockedTerms}  待决候选：${status.pendingTerms}`,
      `世界书条目：${status.worldbookEntries}  待审批：${status.pendingApprovals}`,
      status.translationChannel,
      `G-1 授权：${status.complianceStatus} / ${complianceLabel}`,
      summary ? `[main 摘要] ${summary.slice(0, 80)}…` : '',
      status.runtime ? `运行时层：${status.runtime.runtimeLayer === 'ok' ? '✅ ok' : status.runtime.runtimeLayer === 'unverified' ? '⚠️ 未验证' : status.runtime.runtimeLayer === 'warn' ? '⚠️ warn' : '❌ fail'} / 模式 ${status.runtime.mode?.kind ?? 'unknown'} / 伴侣：${status.runtime.requirements.length ? status.runtime.requirements.map((r) => `${r.name}${r.installed ? '✓' : '❌'}`).join('、') : '无'}` : '',
      fingerprintLine ? fingerprintLine : '',
    ].filter(Boolean).join('\n')
    return { ...tsKnowledgeResult(text), status }
  } catch (err) {
    return { ...tsKnowledgeResult(`状态读取失败：${String(err instanceof Error ? err.message : err)}`, false) }
  } finally {
    knowledge.db.close()
  }
}

/**
 * 运行时部署形态 mode 的 JSON schema（status/verify/select_project 共享）。
 * DSH 输出边界 additionalProperties:false 下，任何一处漏声明 = 整工具硬失败
 * （连 text 都拿不到），故统一引用、禁止各工具手抄。
 */
export const tav2RuntimeModeJsonSchema = {
  description: "运行时部署形态（Ren'Py 原生 tl/<lang> 目录，见 RuntimeMode）",
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        translationDir: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
} as const

/** 运行时伴侣组件 requirements 数组的 JSON schema（status/verify/select_project 共享）。 */
export const tav2RuntimeRequirementsJsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      installed: { type: 'boolean' },
      doc: { type: 'string' },
    },
  },
} as const

/** status 的 runtime 子结构（status/select_project 共享；verify 另有 fileLayer/manualLayer/checks）。 */
export const tav2RuntimeJsonSchema = {
  type: 'object',
  description: '运行时自检（部署形态 + 伴侣组件 + 运行时层结论）',
  properties: {
    mode: tav2RuntimeModeJsonSchema,
    requirements: tav2RuntimeRequirementsJsonSchema,
    runtimeLayer: { type: 'string', enum: ['ok', 'unverified', 'warn', 'fail'] },
  },
  additionalProperties: false,
} as const

/** tav2_status 的完整 status 对象 schema（status 工具 + select_project 嵌套 status 共享）。 */
export const tav2StatusJsonSchema = {
  type: 'object',
  description: '结构化项目总览（engineBackend=ts 时返回）',
  properties: {
    engine: { type: 'string' },
    pluginVersion: { type: 'string' },
    pluginSource: { type: 'string' },
    scenes: { type: 'number' },
    units: { type: 'number' },
    pendingUnits: { type: 'number' },
    lockedTerms: { type: 'number' },
    pendingTerms: { type: 'number' },
    worldbookEntries: { type: 'number' },
    pendingApprovals: { type: 'number' },
    translationChannel: { type: 'string' },
    complianceStatus: { type: 'string' },
    complianceAuthorized: { type: 'boolean' },
    publicReleaseAllowed: { type: 'boolean' },
    summary: { type: 'string' },
    fingerprint: {
      type: 'object',
      description: '版本指纹（engineBackend=ts 时返回）',
      properties: {
        engine: { type: 'string' },
        displayVersion: { type: 'string' },
        fingerprint: { type: 'string' },
        snapshotFingerprint: { type: 'string' },
        hasSnapshot: { type: 'boolean' },
        changed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    runtime: tav2RuntimeJsonSchema,
  },
  additionalProperties: false,
} as const

export function registerStatusTool(ctx: Context, config: Config): void {
  void ctx
  ctx.tools.register(defineTool({
    name: 'tav2_status',
    description: '查询 tav2 翻译项目状态：引擎、场景/单元数、待译数、锁定术语、世界书条目、待审批数。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          status: tav2StatusJsonSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2StatusResult) => {
        const head = value.ok ? 'tav2 状态查询成功' : 'tav2 状态查询失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => statusMeta(_args, value),
    },
    async execute(_args, exec) {
      if (config.engineBackend !== 'python') return runTsStatus(config, modeStatePath())
      const result = await runTav2({ config, args: ['status'], signal: exec.signal })
      return resultToTool(result)
    },
  }))
}
