/**
 * tav2_fingerprint：记录/比对游戏版本指纹快照（非侵入契约的「版本绑定」）。
 * snapshot=写基线（需审批）；check=只读比对当前源文件与快照。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import {
  changedSourcePaths,
  computeGameFingerprint,
  fingerprintChanged,
  readFingerprintSnapshot,
  storeFingerprintSnapshot,
  type GameFingerprint,
} from '../core/fingerprint'
import type { Tav2ToolResult } from '../core/types'
import { ProjectDB } from '../engine/db'
import { loadEngineConfigFor, resolveProjectDbPath, resolveProjectDir } from '../engine/config'
import { tsKnowledgeResult } from './tsKnowledge'

/** 结构化指纹视图（前端展示用）。 */
export interface FingerprintView {
  engine: string
  displayVersion: string
  fingerprint: string
  snapshotFingerprint: string
  hasSnapshot: boolean
  changed: boolean
  changedSources: string[]
  sourceCount: number
}

export interface Tav2FingerprintResult extends Tav2ToolResult {
  fingerprint?: FingerprintView
}

function toView(cur: GameFingerprint, snap: GameFingerprint | null): FingerprintView {
  const changed = snap ? fingerprintChanged(snap, cur) : false
  return {
    engine: cur.engine,
    displayVersion: cur.displayVersion,
    fingerprint: cur.fingerprint,
    snapshotFingerprint: snap?.fingerprint ?? '',
    hasSnapshot: Boolean(snap),
    changed,
    changedSources: snap && changed ? changedSourcePaths(snap, cur) : [],
    sourceCount: cur.sources.length,
  }
}

function short(fp: string): string {
  return fp ? `${fp.slice(0, 12)}…` : '（空）'
}

export function runTsFingerprint(
  config: Config,
  action: 'snapshot' | 'check',
): Tav2FingerprintResult {
  const engineCfg = loadEngineConfigFor(config)
  if (!engineCfg.gameDir) {
    return tsKnowledgeResult('TS 后端需要 config.yaml 中配置 game_dir', false)
  }
  const projectDir = resolveProjectDir(engineCfg, config.engineConfigPath, config.projectDir)
  const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
  try {
    const cur = computeGameFingerprint(engineCfg.engine, engineCfg.gameDir)
    const snap = readFingerprintSnapshot(db)
    if (action === 'snapshot') {
      storeFingerprintSnapshot(db, projectDir, cur)
      const view = { ...toView(cur, cur), hasSnapshot: true }
      const text = [
        `版本指纹快照已记录：${short(cur.fingerprint)}`,
        `显示版本：${cur.displayVersion}`,
        `源文件：${cur.sources.length} 个`,
        `快照文件：${join(projectDir, 'fingerprint.json')}`,
      ].join('\n')
      return { ...tsKnowledgeResult(text), fingerprint: view }
    }
    const view = toView(cur, snap)
    const lines = [
      `版本指纹：${short(cur.fingerprint)}`,
      `显示版本：${cur.displayVersion}`,
      `源文件：${cur.sources.length} 个`,
    ]
    if (!snap) {
      lines.push('⚠️ 尚未建立快照（运行 tav2_fingerprint snapshot 记录基线后再比对）')
    } else if (!view.changed) {
      lines.push('源文件与快照一致，未检测到游戏更新')
    } else {
      lines.push(
        `⚠️ 检测到游戏源文件可能已更新（快照 ${short(snap.fingerprint)} → 当前 ${short(cur.fingerprint)}）`,
        '变化文件：',
        ...view.changedSources.map((p) => `  ~ ${p}`),
        '提示：运行 tav2_diff 对账差异，再走增量迁移（tav2_migrate，下一专项）。',
      )
    }
    return { ...tsKnowledgeResult(lines.join('\n')), fingerprint: view }
  } catch (err) {
    return tsKnowledgeResult(`指纹操作失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    db.close()
  }
}

export function registerFingerprintTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_fingerprint',
    description: '记录或检查游戏版本指纹快照（sha256 源文件 + 显示版本）。'
      + 'snapshot=记录基线（写操作，需审批）；check=只读比对当前源文件与快照。',
    parameters: {
      action: {
        type: 'string',
        enum: ['snapshot', 'check'],
        description: 'snapshot=记录基线（写）；check=比对（读，默认）',
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
          fingerprint: {
            type: 'object',
            description: '结构化指纹视图（engineBackend=ts 时返回）',
            properties: {
              engine: { type: 'string' },
              displayVersion: { type: 'string' },
              fingerprint: { type: 'string' },
              snapshotFingerprint: { type: 'string' },
              hasSnapshot: { type: 'boolean' },
              changed: { type: 'boolean' },
              changedSources: { type: 'array', items: { type: 'string' } },
              sourceCount: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2FingerprintResult) => {
        const head = value.ok ? '版本指纹操作完成' : '版本指纹操作失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      if (config.engineBackend === 'python') {
        return {
          ok: false,
          command: '',
          text: 'engineBackend=python：版本指纹仅 TS 后端支持，请改用 engineBackend=ts 后重试。',
          timedOut: false,
        }
      }
      const action = args.action === 'snapshot' ? 'snapshot' : 'check'
      if (action === 'check') return runTsFingerprint(config, 'check')
      const decision = await requestApproval(
        ctx,
        exec,
        '记录游戏版本指纹快照（写入项目 DB meta 与 work 目录 fingerprint.json）。',
      )
      if (decision !== 'allowed') {
        return { ok: false, command: '', text: approvalDenialText(decision), timedOut: false }
      }
      return runTsFingerprint(config, 'snapshot')
    },
  }))
}
