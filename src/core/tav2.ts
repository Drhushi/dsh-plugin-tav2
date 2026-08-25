import { spawn } from 'node:child_process'
import { delimiter as pathDelimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobKindMap, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Config } from '../config'
import type { Tav2RunResult, Tav2ToolResult } from './types'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    tav2: 'tav2'
  }
}

export interface RunTav2Options {
  config: Config
  /** tav2 子命令与参数，如 ['status'] */
  args: string[]
  /** 覆盖配置里的默认超时 */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface StartTav2JobOptions {
  /** 后台任务的一行描述（模型可见） */
  label: string
  /** tav2 子命令与参数 */
  args: string[]
}

/** 构造 python -m tav2 的完整参数列表。 */
export function buildPythonArgs(config: Config, args: string[]): string[] {
  const pythonArgs = ['-m', config.module]
  if (config.configPath) pythonArgs.push('--config', config.configPath)
  pythonArgs.push(...args)
  return pythonArgs
}

/** 拼接人类可读的命令描述。 */
export function commandString(config: Config, args: string[]): string {
  return `${config.python} ${buildPythonArgs(config, args).map(quoteArg).join(' ')}`
}

/** engineBackend=ts 但对应模块尚未 TS 化时的错误文案。 */
export function pythonBackendError(config: Config, feature: string): string | undefined {
  if (config.engineBackend !== 'python') {
    return `engineBackend=${config.engineBackend}：${feature} 的 TS 引擎尚未实现，当前仅支持 python。`
  }
  return undefined
}

/** 把一次前台执行结果整理成工具规范值。 */
export function resultToTool(result: Tav2RunResult): Tav2ToolResult {
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  return {
    ok: result.ok,
    command: result.command,
    text: text || (result.timedOut ? '命令超时' : '（无输出）'),
    timedOut: result.timedOut,
  }
}

/**
 * 找到从 start 开始的 JSON 括号的匹配结束位置（跳过字符串字面量）。
 * 找不到匹配时返回 -1。
 */
function matchJsonEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从文本尾部提取最后一个 JSON 对象/数组。
 * tav2 常用 print(json.dumps(..., indent=2)) 收尾，因此需要支持多行 JSON；
 * 只尝试“顶层”括号起点（嵌套的内层括号不参与），末尾残留说明文字时按括号匹配截断。
 */
export function parseTrailingJson(text: string): unknown | undefined {
  const topLevelStarts: number[] = []
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) topLevelStarts.push(i)
      depth++
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1)
    }
  }

  for (let k = topLevelStarts.length - 1; k >= 0; k--) {
    const start = topLevelStarts[k]!
    const end = matchJsonEnd(text, start)
    if (end < 0) continue
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // 该片段不是合法 JSON，尝试更早的顶层开头
    }
  }
  return undefined
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符）`
}

/**
 * tav2 Python 仓库根目录（应含 <module>/ 包与 config.yaml）。
 * 优先级：插件配置 pythonRepo > 环境变量 TAV2_PYTHON_REPO > 空串（维持原 cwd 解析行为）。
 */
export function resolvePythonRepo(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return config.pythonRepo || env.TAV2_PYTHON_REPO || ''
}

/**
 * 构造 spawn 用的子进程环境：pythonRepo 可用时把仓库根目录前置注入 PYTHONPATH
 * （保留用户已有的 PYTHONPATH），使 `python -m <module>` 不再依赖 projectDir==仓库。
 */
export function buildSpawnEnv(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const repo = resolvePythonRepo(config, env)
  if (!repo) return env
  return {
    ...env,
    PYTHONPATH: [repo, env.PYTHONPATH].filter(Boolean).join(pathDelimiter),
  }
}

const MISSING_MODULE_RE = /No module named\s+['"]?([A-Za-z_][A-Za-z0-9_.]*)['"]?/i

/**
 * 当 `python -m <module>` 因模块缺失失败时，给出可操作的中文诊断（prepare 链路前置依赖）。
 * 缺失的若不是 <module> 本身（如第三方依赖），按报错名给安装指引，不误判为 tav2 缺失。
 */
export function moduleMissingHint(config: Config, stderr: string): string | undefined {
  const m = stderr.match(MISSING_MODULE_RE)
  if (!m) return undefined
  const missing = m[1]!
  const moduleName = config.module
  const isTav2Module =
    missing === moduleName || missing.startsWith(`${moduleName}.`) || missing.endsWith(`.${moduleName}`)
  const lines = isTav2Module
    ? [
        `未找到 Python 模块「${moduleName}」（python -m ${moduleName} 失败）——这是 prepare（rpa/rpyc 解包）链路的前置依赖，不是插件故障。`,
      ]
    : [
        `python 报「No module named ${missing}」（python -m ${moduleName} 失败）：若这是 prepare 链路的前置依赖，请先安装该包（pip install ${missing}）后重试；若缺失的是 ${moduleName} 本身，按下方指引解决。`,
      ]
  const repo = resolvePythonRepo(config)
  if (repo) {
    lines.push(
      `已注入 PYTHONPATH：${repo}。若仍找不到，请确认该路径是 tav2 仓库根目录（应含 ${moduleName}/ 包目录），或在该目录执行 pip install -e . 安装。`,
    )
  } else {
    lines.push('请任选其一解决：')
    lines.push(
      `  1) 在插件配置里设置 pythonRepo，指向 tav2 仓库根目录（含 config.yaml 与 ${moduleName}/ 包）；`,
    )
    lines.push(`  2) 设置环境变量 TAV2_PYTHON_REPO 指向该目录；`)
    lines.push(
      `  3) 在该目录执行 pip install -e . 使 ${moduleName} 全局可导入，并把插件 projectDir 指向包含 config.yaml 的项目目录。`,
    )
  }
  return lines.join('\n')
}

/** 前台执行 python -m tav2 <子命令>，返回结构化结果。 */
export function runTav2(options: RunTav2Options): Promise<Tav2RunResult> {
  const { config, args } = options
  const timeoutMs = options.timeoutMs ?? config.timeoutMs
  const pythonArgs = buildPythonArgs(config, args)
  const command = commandString(config, args)

  return new Promise<Tav2RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child: ReturnType<typeof spawn> | null = null

    const timer = setTimeout(() => {
      timedOut = true
      child?.kill()
    }, timeoutMs)

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ok = code === 0 && !timedOut
      let errText = stderr
      if (!ok && code !== null) {
        const hint = moduleMissingHint(config, errText)
        if (hint) errText = errText ? `${errText}\n${hint}` : hint
      }
      const parsed = parseTrailingJson(stdout)
      resolve({
        ok,
        command,
        stdout: truncate(stdout, config.maxOutputChars),
        stderr: truncate(errText, config.maxOutputChars),
        code,
        timedOut,
        parsed,
      })
    }

    try {
      child = spawn(config.python, pythonArgs, {
        cwd: config.projectDir || undefined,
        env: buildSpawnEnv(config),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      finish(null)
      return
    }

    const onAbort = () => child?.kill()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${String(err?.message ?? err)}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
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
          output += `\n${String(err?.message ?? err)}`
          resolve({ status: 'failed', detail: 'spawn failed', output })
        })
        child.on('close', (code) => {
          if (cancelled) {
            resolve({ status: 'killed', detail: 'cancelled', output })
          } else {
            if (code !== null && code !== 0) {
              const hint = moduleMissingHint(config, output)
              if (hint) output += `\n${hint}`
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

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}
