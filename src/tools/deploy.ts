import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { pythonBackendError, resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { tlRoot } from '../engine/adapters/renpy/tlparser'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'

export interface DeployOptions {
  /** 公开部署（产出可发布包）：需 G-1 授权；缺省为本地部署。 */
  public?: boolean
}

/** engineBackend=ts：把 game/tl/<lang> 复制到目标游戏目录。 */
export function runTsDeploy(config: Config, target: string, options: DeployOptions = {}): Tav2ToolResult {
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (engineCfg.engine !== 'renpy') {
      return { ok: false, command: 'engineBackend=ts', text: `TS 部署当前只支持 renpy，收到：${engineCfg.engine}`, timedOut: false }
    }

    // G-1 闸门：公开部署必须已取得书面授权；本地自用/学习开发不受限。
    if (options.public) {
      const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
      try {
        if (!db.isPublicReleaseAllowed()) {
          const record = db.getCompliance()
          return {
            ok: false,
            command: 'engineBackend=ts',
            text: `G-1 授权闸门未通过：当前状态 ${record.status}（authorized=${String(record.authorized)}），`
              + '未取得书面授权前禁止公开发布。'
              + '请先用 tav2_compliance 记录授权（status=authorized, authorized=true），'
              + '或改用本地部署（public=false）。',
            timedOut: false,
          }
        }
      } finally {
        db.close()
      }
    }

    const tlDir = tlRoot(engineCfg.gameDir, engineCfg.lang)
    if (!existsSync(tlDir)) {
      return { ok: false, command: 'engineBackend=ts', text: `未找到 ${tlDir}`, timedOut: false }
    }
    const targetGame = existsSync(join(target, 'game')) ? join(target, 'game') : target
    const targetTl = join(targetGame, 'tl', engineCfg.lang)
    cpSync(tlDir, targetTl, { recursive: true })
    return {
      ok: true,
      command: 'engineBackend=ts',
      text: `已部署 tl/${engineCfg.lang} → ${targetTl}${options.public ? '（公开部署，G-1 已通过）' : ''}`,
      timedOut: false,
    }
  } catch (err) {
    return {
      ok: false,
      command: 'engineBackend=ts',
      text: `部署失败：${String(err instanceof Error ? err.message : err)}`,
      timedOut: false,
    }
  }
}

export function registerDeployTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_deploy',
    description: '把 tl/<lang> 部署到目标游戏目录（写操作，需审批）。public=true 时按 G-1 闸门要求已授权才能执行。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: '目标游戏目录（对应 --target）',
      },
      public: {
        type: 'boolean',
        description: '是否公开部署（产出可发布包）；缺省 false=本地部署，不受授权限制',
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
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2ToolResult) => {
        const head = value.ok ? '部署完成' : '部署失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      const decision = await requestApproval(
        ctx,
        exec,
        `部署 tl/<lang> 到 ${args.target}：会复制翻译与字体到目标游戏。`,
      )
      if (decision !== 'allowed') {
        return { ok: false, command: '', text: approvalDenialText(decision), timedOut: false }
      }

      if (config.engineBackend !== 'python') return runTsDeploy(config, args.target, { public: args.public === true })

      // Python 基线 CLI 无 G-1 合规命令：公开部署无法证明授权，fail-closed。
      if (args.public === true) {
        return {
          ok: false,
          command: '',
          text: 'engineBackend=python：G-1 公开部署闸门仅 TS 后端支持；请改用 engineBackend=ts，或改用本地部署（public=false）。',
          timedOut: false,
        }
      }
      const notReady = pythonBackendError(config, 'tav2_deploy')
      if (notReady) return { ok: false, command: '', text: notReady, timedOut: false }
      const result = await runTav2({
        config,
        args: ['deploy', '--target', args.target],
        signal: exec.signal,
      })
      return resultToTool(result)
    },
  }))
}
