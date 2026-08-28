import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { resultToTool, runTav2, startTav2Job } from '../core/tav2'
import { collectSourceFiles } from '../core/fingerprint'
import { loadEngineConfigFor } from '../engine/config'
import { parseRpaArchive, unpackRpaScripts } from '../engine/adapters/renpy/rpa'
import { prepareTemplates } from '../engine/adapters/renpy/prepare'
import { parseDialogueUnits } from '../engine/adapters/renpy/fallbackParser'
import { resolveLang, sessionKeyOf } from './select_project'
import { jobMeta } from '../present/meta'
import { startJobOrFallback, type JobDispatchResult } from './job_fallback'

export interface PrepareArgs {
  game?: string
  sdk?: string
}

/** 构造 prepare CLI 参数（engineBackend 无关：SDK/unrpyc 链路固定走 Python 子进程）。 */
export function buildPrepareArgs(args: PrepareArgs): string[] {
  const cliArgs = ['prepare']
  if (args.game) cliArgs.push('--game', args.game)
  if (args.sdk) cliArgs.push('--sdk', args.sdk)
  return cliArgs
}

/** 解析生效的 Ren'Py SDK 路径：args.sdk 优先，其次 config.renpySdk；空白视为未配置。 */
export function resolvePrepareSdk(config: Config, args: PrepareArgs): string | undefined {
  const sdk = (args.sdk ?? config.renpySdk ?? '').trim()
  return sdk || undefined
}

/** TS 路线的路由计划：.rpy 游戏走 TS，rpyc/显式 --sdk 走 Python。 */
export type PreparePlan =
  | { mode: 'ts'; gameDir: string; lang: string; archives: string[] }
  | { mode: 'python'; reason: string; sdk?: string }
  | { mode: 'error'; reason: string }

/**
 * 决定 prepare 走 TS 还是 Python（prepareBackend/renpySdk 配置接入路由）：
 * - 显式 --sdk（每调用）最高优先 → Python（官方 renpy translate 路线）。
 * - prepareBackend=python → 强制 Python（即使 .rpy 游戏）。
 * - prepareBackend=ts → 强制 TS；仅 .rpyc 时返回 mode error（清晰引导，不碰 python）。
 * - auto（默认）：存在 .rpy 源码（含归档内 .rpy）→ TS（解包覆盖层解析）；
 *   仅 .rpyc（含归档内）→ Python（SDK=args.sdk || config.renpySdk，自动带 --sdk）。
 * 配置不可解析时抛错（调用方回退 Python 自行诊断）。
 */
export function planTsPrepare(config: Config, args: PrepareArgs, sessionKey?: string): PreparePlan {
  const backend = config.prepareBackend ?? 'auto'
  const sdk = resolvePrepareSdk(config, args)
  if (args.sdk?.trim()) {
    return { mode: 'python', reason: '已显式指定 --sdk，走官方 renpy translate 路线（Python SDK）', sdk }
  }
  const engineCfg = loadEngineConfigFor(config)
  if (engineCfg.engine !== 'renpy') {
    return { mode: 'python', reason: `engine=${engineCfg.engine} 非 Ren'Py，由 Python 链路处理` }
  }
  const gameDir = engineCfg.gameDir
  if (!gameDir) return { mode: 'python', reason: 'config.yaml 未配置 game_dir' }
  const lang = resolveLang(config, sessionKey)

  const inputs = collectSourceFiles('renpy', gameDir)
  const rpy = inputs.filter((f) => f.endsWith('.rpy'))
  const rpa = inputs.filter((f) => f.toLowerCase().endsWith('.rpa'))
  const rpyc = inputs.filter((f) => f.endsWith('.rpyc'))

  // 归档索引只读分类（不落盘）。
  let archivesHasRpy = false
  let archivesHasRpyc = false
  for (const f of rpa) {
    const archive = parseRpaArchive(new Uint8Array(readFileSync(f)))
    for (const name of archive.files.keys()) {
      if (name.endsWith('.rpy')) archivesHasRpy = true
      if (name.endsWith('.rpyc')) archivesHasRpyc = true
    }
  }

  const canTs = (): boolean => rpy.length > 0 || archivesHasRpy
  const tsArchives = (): string[] => (rpy.length > 0 ? [] : rpa)

  if (backend === 'python') {
    return { mode: 'python', reason: 'prepareBackend=python：强制走官方 Python 路线（官方 SDK 生成更完整模板）', sdk }
  }
  if (backend === 'ts') {
    if (canTs()) return { mode: 'ts', gameDir, lang, archives: tsArchives() }
    return {
      mode: 'error',
      reason: 'prepareBackend=ts（强制只走 TS 原生）但游戏无可解析的 .rpy 源码（脚本为已编译 .rpyc，TS 不做 rpyc 反编译）。请改 prepareBackend=auto 或 python，并到「设置 → 插件 → dsh-plugin-tav2」配置 renpySdk（或每次传 --sdk）走官方 Python 路线。',
    }
  }

  // auto：.rpy → TS；仅 .rpyc → Python（带 sdk 自动走 --sdk）。
  if (canTs()) return { mode: 'ts', gameDir, lang, archives: tsArchives() }
  if (archivesHasRpyc || rpyc.length > 0) {
    const sdkHint = sdk
      ? `（已带 SDK：${sdk}）`
      : '（未配置 Ren\'Py SDK → 到「设置 → 插件 → dsh-plugin-tav2」填写 renpySdk 路径，或用 tav2_prepare --sdk 指定）'
    return {
      mode: 'python',
      reason: `游戏脚本为已编译 .rpyc，需官方 SDK/unrpyc 走 Python 链路${sdkHint}`,
      sdk,
    }
  }
  return { mode: 'python', reason: '未找到 .rpy/.rpa 脚本（游戏目录可能未就绪，交由 Python 链路诊断）', sdk }
}

export interface TsPrepareRunResult {
  ok: boolean
  command: string
  text: string
  timedOut: boolean
  templateFiles: string[]
  dialogueUnits: number
  stringUnits: number
  /** 幂等合并统计（重跑 prepare / 游戏自带 tl 时非空）：保留的已有已译块 / 追加的缺失块。 */
  merged?: { preservedBlocks: number; addedBlocks: number }
}

/**
 * 尝试走 TS 原生 prepare；不适用（rpyc/显式 --sdk/配置不可解析）时返回 null，
 * 由调用方回退 Python 路径。TS 失败或强制 ts 遇 rpyc（mode error）则返回带错误
 * 文本的前台结果（不回退静默吞错、不碰 python）。
 */
export function tryTsPrepare(config: Config, args: PrepareArgs, sessionKey?: string): TsPrepareRunResult | null {
  let plan: PreparePlan
  try {
    plan = planTsPrepare(config, args, sessionKey)
  } catch {
    return null // 配置解析失败 → 交给 Python 链路自带诊断
  }
  if (plan.mode === 'python') return null
  if (plan.mode === 'error') {
    return {
      ok: false,
      command: `prepare（prepareBackend=${config.prepareBackend ?? 'auto'}）`,
      text: plan.reason,
      timedOut: false,
      templateFiles: [],
      dialogueUnits: 0,
      stringUnits: 0,
    }
  }

  let overlay: string | null = null
  try {
    if (plan.archives.length > 0) {
      overlay = mkdtempSync(join(tmpdir(), 'tav2-prepare-overlay-'))
      for (const f of plan.archives) {
        const archive = parseRpaArchive(new Uint8Array(readFileSync(f)))
        unpackRpaScripts(archive, overlay)
      }
    }
    const parseDir = overlay ?? plan.gameDir
    const result = prepareTemplates(plan.gameDir, plan.lang, parseDialogueUnits, { parseDir })
    const mergeText = result.merged
      ? `\n已有 tl/${plan.lang}：保留 ${result.merged.preservedBlocks} 个已译块（未覆盖），新增 ${result.merged.addedBlocks} 个模板块。`
      : ''
    return {
      ok: true,
      command: `prepare lang=${plan.lang}（TS 原生）`,
      text: `已生成 tl/${plan.lang} 翻译模板（TS 原生，未调用 Python）：\n`
        + result.templateFiles.map((f) => `  ${f}`).join('\n')
        + `\n对话单元 ${result.dialogueUnits} 条、字符串 ${result.stringUnits} 条。`
        + mergeText,
      timedOut: false,
      templateFiles: result.templateFiles,
      dialogueUnits: result.dialogueUnits,
      stringUnits: result.stringUnits,
      ...(result.merged ? { merged: result.merged } : {}),
    }
  } catch (err) {
    return {
      ok: false,
      command: `prepare lang=${plan.lang}（TS 原生）`,
      text: `TS prepare 失败：${String(err instanceof Error ? err.message : err)}`,
      timedOut: false,
      templateFiles: [],
      dialogueUnits: 0,
      stringUnits: 0,
    }
  } finally {
    if (overlay) rmSync(overlay, { recursive: true, force: true })
  }
}

/**
 * 计算 Python 路由的失败上下文：为什么 prepare 走 Python（供失败输出前置，
 * 让「python -m tav2 找不到模块 / SDK 缺失」等失败一眼看懂原因与解法）。
 * 配置不可解析时返回 undefined，由 Python 链路自带诊断。
 */
export function pythonRouteContext(config: Config, args: PrepareArgs, sessionKey?: string): string | undefined {
  try {
    const plan = planTsPrepare(config, args, sessionKey)
    if (plan.mode === 'python') return `prepare 走 Python 的原因：${plan.reason}`
  } catch {
    /* 配置不可解析时交给 Python 链路自带诊断 */
  }
  return undefined
}

export function registerPrepareTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_prepare',
    description: '生成翻译模板（Ren\'Py：tl 模板 + 字体补丁）。有 .rpy 源码的游戏走 TS 原生；'
      + '已编译（.rpyc）游戏或传 --sdk 走 Python（用户自装 Ren\'Py SDK/unrpyc；也可在插件配置里填 renpySdk 免每次传参，'
      + '用 prepareBackend 强制后端）。'
      + '后台任务，完成后会用 job_output 读取结果；后台不可用时经确认前台降级。',
    parameters: {
      game: {
        type: 'string',
        description: '游戏目录覆盖（对应 --game）',
      },
      sdk: {
        type: 'string',
        description: "Ren'Py SDK 路径覆盖（对应 --sdk；传入后强制走官方 Python 路线）",
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['background', 'foreground'] },
          jobId: { type: 'string' },
          label: { type: 'string' },
          ok: { type: 'boolean' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value: JobDispatchResult) => {
        if (value.kind === 'foreground') {
          return [{
            type: 'text',
            text: value.ok ? `已前台降级执行：${value.label}\n${value.text}` : value.text,
          }]
        }
        return [{
          type: 'text',
          text: `已启动后台任务 ${value.jobId}：${value.label}。完成时会收到通知，用 job_output 读取结果。`,
        }]
      },
      presentationMeta: (_args, value) => jobMeta(_args, value),
    },
    async execute(args: PrepareArgs, exec) {
      // TS 优先：.rpy 游戏直接前台完成，不再依赖 python 子进程。
      const tsResult = tryTsPrepare(config, args, sessionKeyOf(exec))
      if (tsResult) {
        return {
          kind: 'foreground' as const,
          ok: tsResult.ok,
          label: `tav2 prepare（TS 原生）`,
          text: tsResult.text,
          timedOut: tsResult.timedOut,
        }
      }
      // 其余（rpyc / 显式 --sdk / 配置不可解析 / 强制 python）→ Python 后台任务（原行为）。
      const cliArgs = buildPrepareArgs(args)
      // 无每调用 --sdk 时，把 config.renpySdk 自动带上（rpyc 游戏免手动传参）。
      if (!args.sdk && resolvePrepareSdk(config, args)) cliArgs.push('--sdk', resolvePrepareSdk(config, args) as string)
      // 失败输出前置「为什么走 Python」，不再只丢一句「No module named tav2」。
      const context = pythonRouteContext(config, args, sessionKeyOf(exec))
      const label = `tav2 prepare${args.game ? ` ${args.game}` : ''}（Python SDK/unrpyc 子进程）`
      return startJobOrFallback(ctx, config, exec, {
        label,
        start: () => startTav2Job(ctx, config, { label, args: cliArgs, context }, exec.agent),
        foreground: async (signal) => {
          const t = resultToTool(await runTav2({ config, args: cliArgs, context, signal }))
          return { ok: t.ok, text: `${t.command}\n${t.text}`, timedOut: t.timedOut }
        },
      })
    },
  }))
}
