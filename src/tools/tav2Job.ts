/**
 * 以后台任务方式执行 python -m tav2（dsh ctx.jobs）。
 * dsh 专属绑定：ctx.jobs / Agent / JobKindMap 都在工具层——core 只保留前台 runTav2。
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobKindMap, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Config } from '../config'
import { buildFailureText, buildPythonArgs, buildSpawnEnv } from '../core/tav2'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    tav2: 'tav2'
  }
}

export interface StartTav2JobOptions {
  /** 后台任务的一行描述（模型可见） */
  label: string
  /** tav2 子命令与参数 */
  args: string[]
  /** 失败时前置到任务输出的上下文说明（如 prepare 为什么走 Python 路由） */
  context?: string
}

/**
 * 以后台任务方式执行 python -m tav2（dsh ctx.jobs）。
 * 返回任务 id；进度通过 readOutput 流式读取，完成通知由 tool-jobs 投递。
 */
export function startTav2Job(
  ctx: Context,
  config: Config,
  options: StartTav2JobOptions,
  owner?: Agent,
): JobId {
  const pythonArgs = buildPythonArgs(config, options.args)
  return ctx.jobs.start({
    kind: 'tav2' as JobKindMap['tav2'],
    label: options.label,
    outputLimitBytes: config.maxOutputChars * 3,
    // 必须带 owner：web profile 里宿主 tool-jobs 被禁用，job controller 只由
    // 预设层挂载，serve 的是该预设作用域下的 agent；无 owner 的任务只能被
    // 全局 controller 受理，会报 “no job controller serves this agent”。
    owner,
    run() {
      let output = ''
      let cancelled = false
      const child = spawn(config.python, pythonArgs, {
        cwd: config.projectDir || undefined,
        env: buildSpawnEnv(config),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })

      const done = new Promise<JobOutcome>((resolve) => {
        child.on('error', (err) => {
          output = buildFailureText(config, String(err?.message ?? err), {
            context: options.context,
            code: null,
          })
          resolve({ status: 'failed', detail: 'spawn failed', output })
        })
        child.on('close', (code) => {
          if (cancelled) {
            resolve({ status: 'killed', detail: 'cancelled', output })
          } else {
            if (code !== null && code !== 0) {
              output = buildFailureText(config, output, { context: options.context, code })
            }
            resolve({
              status: code === 0 ? 'completed' : 'failed',
              ...code === 0 ? {} : { detail: `exit code: ${code}` },
              output,
            })
          }
        })
      })

      return {
        cancel: () => {
          cancelled = true
          child.kill()
        },
        done,
        readOutput: () => {
          const text = output
          output = ''
          return text
        },
      }
    },
  })
}
