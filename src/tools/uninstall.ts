/**
 * tav2_uninstall：按补丁包 manifest 精确删除交付文件（非侵入契约的「可删还原」）。
 *
 * 只删除补丁清单内登记、且解析后仍在目标根目录内的路径；删除前需审批；
 * dryRun=只预览清单不删除。运行时不登记运行时组件（字体等），
 * 它们属用户管理的「运行时前置条件」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { listManifestTargets, readManifest } from '../core/manifest'
import type { Tav2ToolResult } from '../core/types'
import { loadEngineConfigFor } from '../engine/config'
import { tsKnowledgeResult } from './tsKnowledge'

export interface UninstallView {
  patchDir: string
  target: string
  manifestFingerprint: string
  listed: number
  deleted: string[]
  missing: string[]
  dryRun: boolean
}

export interface Tav2UninstallResult extends Tav2ToolResult {
  uninstall?: UninstallView
}

/** 自底向上删除空目录，直到 stopRoot（不含 stopRoot 本身）。 */
function pruneEmptyDirs(start: string, stopRoot: string): void {
  let cur = resolve(start)
  const stop = resolve(stopRoot)
  while (cur.startsWith(stop + sep) && cur !== stop) {
    try {
      if (readdirSync(cur).length === 0) {
        rmdirSync(cur)
        cur = dirname(cur)
      } else {
        break
      }
    } catch {
      break
    }
  }
}

export function runTsUninstall(
  config: Config,
  args: { patchDir?: string; target?: string; dryRun?: boolean },
): Tav2UninstallResult {
  const engineCfg = loadEngineConfigFor(config)
  const gameName = basename(engineCfg.gameDir || 'game')
  const patchDir = (args.patchDir ?? '').trim()
    || join(config.projectDir || process.cwd(), 'patch', gameName)
  const target = (args.target ?? '').trim() || engineCfg.gameDir
  if (!target) {
    return tsKnowledgeResult('TS 后端需要 config.yaml 中配置 game_dir（或用 target 显式指定），才能解析补丁路径', false)
  }
  const manifest = readManifest(patchDir)
  if (!manifest) {
    return tsKnowledgeResult(`未找到补丁清单：${join(patchDir, 'tav2-manifest.json')}`, false)
  }
  const targets = listManifestTargets(manifest, target)
  const existing = targets.filter((t) => existsSync(t.abs))
  const missing = targets.filter((t) => !existsSync(t.abs))
  const view: UninstallView = {
    patchDir,
    target,
    manifestFingerprint: manifest.fingerprint,
    listed: targets.length,
    deleted: existing.map((t) => t.rel),
    missing: missing.map((t) => t.rel),
    dryRun: Boolean(args.dryRun),
  }

  if (args.dryRun) {
    const shown = existing.slice(0, 50)
    const text = [
      `[dry-run] 将删除补丁清单内 ${existing.length} 个文件（${missing.length} 个不存在会跳过）：`,
      ...shown.map((t) => `  - ${t.rel}`),
      existing.length > 50 ? `  …（共 ${existing.length} 个）` : '',
      `目标：${target}`,
      `清单指纹：${manifest.fingerprint ? `${manifest.fingerprint.slice(0, 12)}…` : '（无）'}`,
    ].filter(Boolean).join('\n')
    return { ...tsKnowledgeResult(text), uninstall: view }
  }

  for (const t of existing) {
    try {
      rmSync(t.abs, { force: true })
    } catch {
      // 单个失败不阻断其余；最终计数仍以成功删除为准
    }
    pruneEmptyDirs(dirname(t.abs), target)
  }
  const text = [
    `已删除补丁清单内 ${existing.length} 个文件（${missing.length} 个缺失已跳过）。`,
    `目标：${target}`,
    `清单指纹：${manifest.fingerprint ? `${manifest.fingerprint.slice(0, 12)}…` : '（无）'}`,
    '运行时前置条件（字体等）未在此次删除范围内。',
  ].join('\n')
  return { ...tsKnowledgeResult(text), uninstall: view }
}

export function registerUninstallTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_uninstall',
    description: '按补丁包 tav2-manifest.json 精确删除交付文件（可删还原）。'
      + '只删清单内路径，越界拒绝；删除前需审批；dryRun=只预览。',
    parameters: {
      patchDir: {
        type: 'string',
        description: '补丁包目录（缺省=projectDir/patch/<游戏名>）',
      },
      target: {
        type: 'string',
        description: '删除目标根目录（缺省=config.yaml 的 game_dir；通常已合并补丁的游戏根目录）',
      },
      dryRun: { type: 'boolean', description: 'true=只预览删除清单不删除' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          uninstall: {
            type: 'object',
            description: '结构化卸载结果（engineBackend=ts 时返回）',
            properties: {
              patchDir: { type: 'string' },
              target: { type: 'string' },
              manifestFingerprint: { type: 'string' },
              listed: { type: 'number' },
              deleted: { type: 'array', items: { type: 'string' } },
              missing: { type: 'array', items: { type: 'string' } },
              dryRun: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2UninstallResult) => {
        const head = value.ok ? '卸载操作完成' : '卸载操作失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      if (config.engineBackend === 'python') {
        return {
          ok: false,
          command: '',
          text: 'engineBackend=python：tav2_uninstall 仅 TS 后端支持，请改用 engineBackend=ts 后重试。',
          timedOut: false,
        }
      }
      const preview = runTsUninstall(config, { ...args, dryRun: true })
      if (!preview.ok || args.dryRun === true) return preview
      const count = preview.uninstall?.deleted.length ?? 0
      const decision = await requestApproval(
        ctx,
        exec,
        `卸载补丁：删除补丁清单内 ${count} 个文件（目标 ${preview.uninstall?.target ?? ''}）。`,
      )
      if (decision !== 'allowed') {
        return { ok: false, command: '', text: approvalDenialText(decision), timedOut: false }
      }
      return runTsUninstall(config, args)
    },
  }))
}
