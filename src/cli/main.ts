#!/usr/bin/env node
/**
 * tav2kit CLI 入口：独立软件形态的 agent 工具面（SPEC-STANDALONE Phase 1）。
 * 只读命令直接复用 src/tools 的 runTs* 纯函数——与 dsh 插件共享同一套实现（单一事实源）；
 * 本文件只做：参数解析、命令路由、输出契约（--json）、退出码。
 *
 * 退出码契约：0=成功；1=业务失败；2=用法错误（含项目 config.yaml 缺失）；
 * 4=需要确认（写操作未给 --yes）。3 预留给 fail-closed 拒绝（Phase 2 写路径起使用）。
 */
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { pluginSource, pluginVersion } from '../version'
import { parseArgs } from './args'
import { runDoctor } from './doctor'
import { runTsDetect } from '../tools/detect'
import { runTsStatus } from '../tools/status'
import { runTsCheck } from '../tools/check'
import { runTsVerify } from '../tools/verify'
import { runTsReport } from '../tools/report'
import { runTsFingerprint } from '../tools/fingerprint'
import { runTsDiff } from '../tools/diff'
import { runTsInit, runTsInitComplete } from '../tools/init'
import { runTsFontList, runTsFontPick, runTsFontPickWrite, type FontToolArgs } from '../tools/font'
import { runTsApply, runTsDelete, runTsList, runTsUpdate } from '../tools/terms'
import { buildPrepareArgs, pythonRouteContext, resolvePrepareSdk, tryTsPrepare } from '../tools/prepare'
import { resultToTool, runTav2 } from '../core/tav2'
import { readConfigSummary, writeConfigValue } from './config'
import { configSetPreview } from './config'
import { resolveCliGenerate } from './llm'
import { runTsWorldbook, type WorldbookArgs } from '../tools/worldbook'
import { runTsDeliberate } from '../tools/deliberate'
import { runSingleTsJob, runTsReviewBackfill } from '../tools/ts_jobs'
import { planSubagentBatches } from '../tools/ts_subagents'
import { loadKnowledgeInput } from '../tools/tsKnowledge'
import { runTsMigrate } from '../tools/migrate'
import { runTsUninstall } from '../tools/uninstall'
import { runTsCompliance } from '../tools/compliance'
import { runTsPack } from '../tools/pack'
import { runTsDeploy } from '../tools/deploy'
import { loadEngineConfigFor } from '../engine/config'
import type { Generate } from '../engine/llm'
import { RENPY_BOOKLETS } from '../skills/renpy'
import { TAV2_WORKFLOW_CONTENT } from '../skills/workflow'

/** 用法错误：退出码 2，给 agent/人工可操作的指引。 */
export class UsageError extends Error {}

export interface CliIo {
  out: (s: string) => void
  err: (s: string) => void
}

/** 测试注入点：cwd 与 Python 探测可替换。 */
export interface CliDeps {
  cwd?: string
  pythonProbe?: (python: string) => Promise<string | undefined>
}

const BOOLEAN_FLAGS = ['json', 'yes', 'help', 'version'] as const

/** 命令面单一事实源：--help 输出 + Phase 4 生成脚本（SKILL.md/AGENTS.md 命令参考）共用。 */
export const HELP = `tav2kit — 独立 agent 驱动的游戏本地化工具（当前完整适配 Ren'Py）

用法：tav2kit <命令> [参数] [选项]

命令：
  detect [游戏目录]            探测引擎类型与文件布局（识别到 Unity/Yarn 会明确提示暂不可用）
  init [游戏目录]              初始化翻译项目：探测游戏 → dry-run 预览将写 config.yaml；--yes 生成
  status                       项目状态总览（需项目 config.yaml）
  font list|pick <id>          字体候选（list 只读）；pick 落地到 tl/<lang>/font/（写操作，需 --yes）
  terms list|apply|update|delete  术语管理（apply/update/delete 为写操作，需 --yes）
  prepare                      生成翻译模板（.rpy 走 TS 原生；.rpyc 或 --sdk 走 Python 前台）
  check                        标识符/标签完整性 + 世界书↔术语一致性 + 模板外残留对账
  verify                       三层运行验证（文件层 / 运行时层 / 实机确认指引）
  report                       覆盖率 / 风险 / 审校队列 / 成本报表
  fingerprint [check|snapshot] 版本指纹比对（默认 check）；snapshot 记录基线（写操作，需 --yes）
  diff <旧目录> <新目录>       对账新旧游戏目录翻译文件差异（--lang 指定语言，默认 chinese）
  config get|set <key> <value> 读/写项目 config.yaml（set 支持 lang 与 translationApi.*，需 --yes）
  worldbook [nominate|accept|dismiss]  世界书提名制（需 LLM 渠道；accept/dismiss 需提名 id）
  deliberate                  术语多方位推敲（需 LLM 渠道；CLI 无联网查证）
  translate [场景id…]        双阶段翻译：进程内并发池按窗口并行（--limit 窗口数，--workers 并行上限）
  review --file <xlsx>        审校表回填 tl + 同步 DB（--force 忽略状态）
  pack [--out <dir>]          补丁打包 + manifest（closure 收尾门禁 fail-closed）
  migrate [--yes]             游戏更新增量迁移（写操作；未 --yes 预览计划退出码 4）
  deploy <目标目录> [--public]  复制 tl/<lang> 到目标游戏（public 需 G-1 授权）
  uninstall [--yes]           按补丁清单精确卸载（写操作；未 --yes 预览退出码 4）
  compliance get|set <status> 读/写 G-1 授权合规记录（set 为写操作，需 --yes）
  skill print [--booklet 名]   输出 agent 工作流知识（默认主流程；分册：font / langswitch / closure）
  doctor                       环境自检（node / python / tav2 后端 / 项目）
  version                      版本与加载来源

选项：
  --json            机器可读输出（结构化结果 JSON，字段与 dsh 工具一致）
  --project <dir>   项目目录（含 config.yaml；缺省用当前目录）
  --yes             确认写操作（init / font pick / terms 写 / config set 等；未给时 dry-run 预览并退出码 4）
  --python <exe>    Python 可执行文件（缺省 python）
  --sdk <path>      Ren'Py SDK 路径（prepare；传入后强制走 Python 官方路线）
  --dir <dir>       额外手动字体目录（font list/pick）

退出码：0 成功；1 业务失败；2 用法错误；4 需要确认（写操作未给 --yes）。
说明：当前覆盖 TS 后端只读命令 + init/font/terms/prepare/config 写路径；翻译 / 世界书 / 推敲等
其余写路径见 docs/SPEC-STANDALONE.md（Phase 2 后续批次）。`

/** CLI 侧插件级 Config：内置默认值 + --python 覆盖。项目 config.yaml 是另一层（engine 层按需读取）。 */
function cliConfig(projectDir: string, flags: Record<string, string | true>): Config {
  return {
    python: typeof flags.python === 'string' && flags.python.trim() ? flags.python.trim() : 'python',
    module: 'tav2',
    configPath: '',
    projectDir,
    engineConfigPath: '',
    projectOverride: '',
    llmProvider: '',
    timeoutMs: 900_000,
    maxOutputChars: 20_000,
    engineBackend: 'ts',
    approval: 'ask',
  }
}

interface CliResult {
  ok: boolean
  text: string
}

/** 统一输出：--json 打整对象（字段与 dsh 工具一致），人读打「标题 + text」。 */
function emit(result: CliResult, head: string, failHead: string, json: boolean, io: CliIo): number {
  if (json) {
    io.out(JSON.stringify(result, null, 2))
  } else {
    io.out(`${result.ok ? head : failHead}\n${result.text}`)
  }
  return result.ok ? 0 : 1
}

function truthyFlag(flags: Record<string, string | true>, name: string): boolean {
  const v = flags[name]
  return v === true || (typeof v === 'string' && v !== '' && v !== 'false')
}

/**
 * CLI 写门（SPEC §3.2）：写命令统一 dry-run / 确认契约，不依赖 TTY。
 * - 无写需要（needsWrite 非真）：返回 null，调用方正常 emit 结果。
 * - 需写但未给 --yes：dry-run——输出将写预览（含路径清单），返回退出码 4（需要确认）。
 * - 需写且给了 --yes：返回 null，调用方执行实际写。
 */
function writeGate(
  res: Tav2ToolResult & { needsWrite?: boolean; preview?: string },
  yes: boolean,
  json: boolean,
  io: CliIo,
): number | null {
  if (!res.needsWrite) return null
  if (yes) return null
  if (json) {
    io.out(JSON.stringify(res, null, 2))
  } else {
    io.out(`写操作预览（dry-run，未写任何文件）：\n${res.preview ?? res.text}`)
  }
  io.err('写操作需要确认：加 --yes 执行（本输出只是预览）。')
  return 4
}

/**
 * 写操作门（预览形态，用于 translate/review/pack/deploy 等无显式 dryRun 参数的写命令）：
 * 未 --yes → 打印将写预览 + 退出码 4；--yes → 返回 null 放行执行。
 */
function confirmWrite(preview: string, yes: boolean, json: boolean, io: CliIo): number | null {
  if (yes) return null
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'write', text: preview, timedOut: false, needsWrite: true, preview }, null, 2))
  } else {
    io.out(`写操作预览（dry-run，未写任何文件）：\n${preview}`)
  }
  io.err('写操作需要确认：加 --yes 执行（本输出只是预览）。')
  return 4
}

/** 进程内并发池（有界 Promise 并行）：CLI 侧替代 dsh 子代理分批编排。 */
async function runBatchPool<T>(
  batches: string[][],
  workers: number,
  fn: (sceneIds: string[], index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(batches.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < batches.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(batches[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, batches.length)) }, run))
  return results
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const { positionals, flags } = parseArgs(argv, BOOLEAN_FLAGS)
  const json = truthyFlag(flags, 'json')
  const cmd = positionals[0] ?? 'help'

  if (truthyFlag(flags, 'help') || cmd === 'help' || cmd === '--help') {
    io.out(HELP)
    return 0
  }
  if (truthyFlag(flags, 'version') || cmd === 'version' || cmd === '--version') {
    const line = `tav2kit v${pluginVersion()}（加载来源 ${pluginSource()}）`
    if (json) io.out(JSON.stringify({ name: 'tav2kit', version: pluginVersion(), source: pluginSource() }, null, 2))
    else io.out(line)
    return 0
  }

  const cwd = deps.cwd ?? process.cwd()
  const projectDir = resolve(typeof flags.project === 'string' && flags.project.trim() ? flags.project.trim() : cwd)

  /** 项目绑定命令（status/check/verify/report/fingerprint）前置：config.yaml 必须在场。 */
  const requireProject = (): void => {
    if (!existsSync(join(projectDir, 'config.yaml'))) {
      throw new UsageError(
        `未找到项目 config.yaml（查找：${projectDir}）。\n`
        + '项目 config.yaml 需含 engine: renpy / game_dir / lang（在游戏根目录或其上层）。\n'
        + '脱离项目可用的命令：detect / skill / doctor / version。',
      )
    }
  }

  try {
    switch (cmd) {
      case 'detect': {
        const cfg = cliConfig(projectDir, flags)
        const result = runTsDetect(cfg, positionals[1] ?? undefined)
        return emit(result, '引擎探测完成', '引擎探测失败', json, io)
      }
      case 'init': {
        const cfg = cliConfig(projectDir, flags)
        const result = runTsInit(cfg, positionals[1], cwd)
        const gate = writeGate(result, truthyFlag(flags, 'yes'), json, io)
        if (gate !== null) return gate
        // 复用 app 层完整流程（与 dsh 同源）：approve 直接放行 + 摄入已有 tl 译文。
        const final = await runTsInitComplete(cfg, positionals[1], cwd, { approve: async () => 'allowed' })
        // wroteConfig 是内部会话标记（非工具契约字段），--json 不输出。
        const { wroteConfig: _wroteConfig, ...tool } = final
        return emit(tool, '翻译项目初始化完成', '翻译项目初始化失败', json, io)
      }
      case 'font': {
        const verb = positionals[1] ?? 'list'
        const cfg = cliConfig(projectDir, flags)
        const args: FontToolArgs = typeof flags.dir === 'string' && flags.dir.trim()
          ? { dir: flags.dir }
          : {}
        if (verb === 'list') {
          requireProject()
          return emit(runTsFontList(cfg, args), '字体候选', '字体列表失败', json, io)
        }
        if (verb === 'pick') {
          requireProject()
          const id = positionals[2]
          if (!id) throw new UsageError('font pick 需要字体 id（见 font list）或绝对路径。')
          const plan = runTsFontPick(cfg, { ...args, font: id })
          const gate = writeGate(plan, truthyFlag(flags, 'yes'), json, io)
          if (gate !== null) return gate
          if (plan.needsWrite) {
            return emit(runTsFontPickWrite(cfg, { ...args, font: id }), '字体应用完成', '字体应用失败', json, io)
          }
          return emit(plan, '字体', '字体失败', json, io)
        }
        throw new UsageError(`font 只支持 list / pick（收到：${verb}）。`)
      }
      case 'terms': {
        const verb = positionals[1] ?? 'list'
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const flag = (name: string): string | undefined =>
          typeof flags[name] === 'string' ? String(flags[name]) : undefined
        const yes = truthyFlag(flags, 'yes')
        if (verb === 'list') {
          return emit(runTsList(cfg, flag('status')), '术语列表', '术语列表失败', json, io)
        }
        if (verb === 'apply') {
          const source = flag('source')
          const target = flag('target')
          if (!source || !target) {
            throw new UsageError('terms apply 需要 --source <词> --target <译文> [--category <类>]。')
          }
          const preview = `将锁定术语：${source} → ${target}${flag('category') ? `（${flag('category')}）` : ''}（写项目知识库）`
          const gate = writeGate(
            { ok: true, command: 'terms apply', text: preview, timedOut: false, needsWrite: true, preview },
            yes,
            json,
            io,
          )
          if (gate !== null) return gate
          const item = { source, target, ...(flag('category') ? { category: flag('category') as string } : {}) }
          return emit(runTsApply(cfg, [item]), '术语锁定完成', '术语锁定失败', json, io)
        }
        if (verb === 'update') {
          const idRaw = flag('id')
          const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined
          const source = flag('source')
          if (id === undefined && !source) {
            throw new UsageError('terms update 需要 --id <n> 或 --source <词>（[--target <译文>] [--category <类>]）。')
          }
          const preview = `将更新术语（${id !== undefined ? `id=${id}` : `source=${source}`}）`
          const gate = writeGate(
            { ok: true, command: 'terms update', text: preview, timedOut: false, needsWrite: true, preview },
            yes,
            json,
            io,
          )
          if (gate !== null) return gate
          const item = {
            ...(id !== undefined ? { id } : {}),
            ...(source ? { source } : {}),
            ...(flag('target') ? { target: flag('target') as string } : {}),
            ...(flag('category') ? { category: flag('category') as string } : {}),
          }
          return emit(runTsUpdate(cfg, [item]), '术语更新完成', '术语更新失败', json, io)
        }
        if (verb === 'delete') {
          const idRaw = flag('id')
          const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined
          const source = flag('source')
          if (id === undefined && !source) {
            throw new UsageError('terms delete 需要 --id <n> 或 --source <词>。')
          }
          const preview = `将删除术语（${id !== undefined ? `id=${id}` : `source=${source}`}）`
          const gate = writeGate(
            { ok: true, command: 'terms delete', text: preview, timedOut: false, needsWrite: true, preview },
            yes,
            json,
            io,
          )
          if (gate !== null) return gate
          return emit(
            runTsDelete(cfg, [id !== undefined ? { id } : { source }]),
            '术语删除完成',
            '术语删除失败',
            json,
            io,
          )
        }
        throw new UsageError(`terms 只支持 list / apply / update / delete（收到：${verb}）。`)
      }
      case 'prepare': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const args = typeof flags.sdk === 'string' && flags.sdk.trim() ? { sdk: flags.sdk } : {}
        const tsResult = tryTsPrepare(cfg, args)
        if (tsResult) return emit(tsResult, 'prepare 完成（TS 原生）', 'prepare 失败（TS 原生）', json, io)
        // Python 路由（rpyc / 显式 --sdk / 配置不可解析）：前台执行 python -m tav2 prepare。
        const cliArgs = buildPrepareArgs(args)
        if (!args.sdk && resolvePrepareSdk(cfg, args)) cliArgs.push('--sdk', resolvePrepareSdk(cfg, args) as string)
        const context = pythonRouteContext(cfg, args)
        const t = resultToTool(await runTav2({ config: cfg, args: cliArgs, context }))
        return emit(t, 'prepare 完成（Python 路由）', 'prepare 失败（Python 路由）', json, io)
      }
      case 'config': {
        requireProject()
        const verb = positionals[1] ?? 'get'
        if (verb === 'get') {
          return emit(readConfigSummary(projectDir), '项目配置', '配置读取失败', json, io)
        }
        if (verb === 'set') {
          const key = positionals[2]
          const value = positionals[3]
          if (!key || value === undefined) {
            throw new UsageError('config set <key> <value>；可用 key：lang / translationApi.baseUrl|model|scope|apiKeyEnv。')
          }
          const configPath = join(projectDir, 'config.yaml')
          const blocked = configSetPreview(configPath, key, value)
          if (blocked) return emit(blocked, '配置已更新', '配置更新被拒绝', json, io)
          const preview = `将更新 ${configPath}：\n  ${key}: ${value}`
          const gate = writeGate(
            { ok: true, command: 'config set', text: preview, timedOut: false, needsWrite: true, preview },
            truthyFlag(flags, 'yes'),
            json,
            io,
          )
          if (gate !== null) return gate
          return emit(writeConfigValue(configPath, key, value), '配置已更新', '配置更新失败', json, io)
        }
        throw new UsageError(`config 只支持 get / set（收到：${verb}）。`)
      }
      case 'worldbook': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const args: WorldbookArgs = {}
        const verb = positionals[1] ?? 'nominate'
        if (verb === 'accept' || verb === 'dismiss') {
          const ids = positionals.slice(2).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
          if (ids.length === 0) throw new UsageError(`worldbook ${verb} <提名id…>（id 见 worldbook 输出清单）。`)
          if (verb === 'accept') args.accept = ids
          else args.dismiss = ids
          // 写操作门：accept 出卡（写 DB 草案）/ dismiss 驳回（写 DB 终态）——与 terms 写操作同类。
          const gate = confirmWrite(
            `worldbook ${verb} <${ids.join(',')}>：${verb === 'accept' ? '为提名生成卡片草案（proposed，待 edit confirm）' : '驳回提名（写 DB 终态）'}。`,
            truthyFlag(flags, 'yes'),
            json,
            io,
          )
          if (gate !== null) return gate
        } else if (verb !== 'nominate') {
          throw new UsageError(`worldbook 只支持 nominate / accept / dismiss（收到：${verb}）。`)
        }
        if (typeof flags.limit === 'string' && /^\d+$/.test(flags.limit)) {
          args.limit = Number(flags.limit)
        }
        const engineCfg = loadEngineConfigFor(cfg)
        let generate: Generate
        try {
          generate = resolveCliGenerate(cfg, engineCfg)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          return emit({ ok: false, text: `worldbook 需要 LLM 渠道：${detail}` }, '', '世界书提名失败', json, io)
        }
        const result = await runTsWorldbook(undefined, cfg, args, { generate })
        return emit(result, '世界书提名完成', '世界书提名失败', json, io)
      }
      case 'deliberate': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const engineCfg = loadEngineConfigFor(cfg)
        let generate: Generate
        try {
          generate = resolveCliGenerate(cfg, engineCfg)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          return emit({ ok: false, text: `deliberate 需要 LLM 渠道：${detail}` }, '', '术语推敲失败', json, io)
        }
        // CLI 无 tool-web：查证留空（引擎本地证据 + LLM 判定；联网查证留给 dsh 薄壳）。
        const result = await runTsDeliberate(undefined, cfg, undefined, {
          generate,
          evidence: async () => [],
        })
        return emit(result, '术语推敲完成', '术语推敲失败', json, io)
      }
      case 'translate': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const yes = truthyFlag(flags, 'yes')
        const limit = typeof flags.limit === 'string' && /^\d+$/.test(flags.limit) ? Number(flags.limit) : undefined
        const workers = typeof flags.workers === 'string' && /^\d+$/.test(flags.workers) ? Number(flags.workers) : undefined
        const review = truthyFlag(flags, 'review')
        const budget = typeof flags.budget === 'string' && /^\d+$/.test(flags.budget) ? Number(flags.budget) : undefined
        const scenes = positionals.slice(1)
        const input = loadKnowledgeInput(cfg)
        const pendingIds = input.document.scenes
          .filter((s) => s.units.some((u) => !u.extra.translated))
          .map((s) => s.scene_id)
        const wanted = scenes.length > 0 ? new Set(scenes) : undefined
        const baseIds = wanted === undefined ? pendingIds : pendingIds.filter((id) => wanted.has(id))
        const maxWorkers = Math.max(1, Math.floor(workers ?? (cfg.subagentMaxWorkers ?? 2)))
        const plan = planSubagentBatches(baseIds, limit, maxWorkers)
        if (plan.batches.length === 0) {
          return emit({ ok: true, text: '没有待译场景（已全部翻译或窗口为空）。' }, '翻译完成', '翻译失败', json, io)
        }
        // 写操作门：未 --yes 只预览窗口（不发 LLM、不写盘）。
        const gate = confirmWrite(
          `将翻译 ${plan.total} 个场景（切 ${plan.batches.length} 批并行，上限 ${maxWorkers}），`
          + `写回 tl/${input.engineCfg.lang}/ 并更新项目 DB${review ? '（审校模式：不写回 tl，导出审校表）' : ''}。`,
          yes,
          json,
          io,
        )
        if (gate !== null) return gate
        const engineCfg = loadEngineConfigFor(cfg)
        let generate: Generate
        try {
          generate = resolveCliGenerate(cfg, engineCfg)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          return emit({ ok: false, text: `translate 需要 LLM 渠道：${detail}` }, '', '翻译失败', json, io)
        }
        const lines: string[] = []
        const log = (line: string) => { lines.push(line) }
        const controller = new AbortController()
        // 进程内并发池（替代 dsh 子代理并行）：按 plan 切批，至多 maxWorkers 个窗口并行直跑。
        const outcomes = await runBatchPool(plan.batches, maxWorkers, (sceneIds, index) =>
          runSingleTsJob(undefined, cfg, {
            label: `batch-${index + 1}`,
            scenes: sceneIds,
            review,
            budget,
          }, log, controller.signal, { generate }))
        const failed = outcomes.filter((o) => o.status !== 'completed')
        if (failed.length > 0) {
          lines.push(`${failed.length} 个批次失败：${failed.map((o) => o.detail).join('；')}`)
        }
        const text = lines.join('\n')
        return emit({ ok: failed.length === 0, text }, '翻译完成', '翻译失败', json, io)
      }
      case 'migrate': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const yes = truthyFlag(flags, 'yes')
        // 写门：approve 注入——未 --yes 时返回 unavailable，runTsMigrate 以「未获批准 + 计划预览」返回。
        const approve = async () => (yes ? 'allowed' : 'unavailable') as 'allowed' | 'unavailable'
        const result = await runTsMigrate(cfg, { approve })
        if (!result.ok && result.plan && !yes) {
          if (json) {
            io.out(JSON.stringify(result, null, 2))
          } else {
            io.out(`迁移计划预览（dry-run，未做任何写入）：\n${result.text}`)
          }
          io.err('迁移是写操作（同步 DB 状态 + 归档旧补丁）：加 --yes 执行。')
          return 4
        }
        return emit(result, '增量迁移完成', '增量迁移未执行', json, io)
      }
      case 'uninstall': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const yes = truthyFlag(flags, 'yes')
        const args = {
          ...(typeof flags.patch === 'string' && flags.patch.trim() ? { patchDir: flags.patch } : {}),
          ...(typeof flags.target === 'string' && flags.target.trim() ? { target: flags.target } : {}),
        }
        if (!yes) {
          const preview = runTsUninstall(cfg, { ...args, dryRun: true })
          if (!preview.ok) return emit(preview, '', '卸载预览失败', json, io)
          if (json) {
            io.out(JSON.stringify(preview, null, 2))
          } else {
            io.out(`卸载预览（dry-run，未删除任何文件）：\n${preview.text}`)
          }
          io.err('卸载是写操作（按补丁清单精确删除）：加 --yes 执行。')
          return 4
        }
        return emit(runTsUninstall(cfg, args), '卸载完成', '卸载失败', json, io)
      }
      case 'compliance': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const verb = positionals[1] ?? 'get'
        if (verb === 'get') {
          return emit(runTsCompliance(cfg), '合规记录', '合规记录读取失败', json, io)
        }
        if (verb === 'set') {
          const status = positionals[2]
          if (!status) throw new UsageError('compliance set <status>（unknown|local-only|authorized）。')
          const set: Record<string, unknown> = { status }
          if (typeof flags.author === 'string' && flags.author.trim()) set.author = flags.author
          if (typeof flags.copyrightOwner === 'string' && flags.copyrightOwner.trim()) set.copyrightOwner = flags.copyrightOwner
          if (flags.authorized === 'true' || flags.authorized === 'false') set.authorized = flags.authorized === 'true'
          const preview = `将写入合规记录：status=${status}`
            + `${set.author ? `, author=${String(set.author)}` : ''}`
            + `${set.authorized !== undefined ? `, authorized=${String(set.authorized)}` : ''}`
          const gate = writeGate(
            { ok: true, command: 'compliance set', text: preview, timedOut: false, needsWrite: true, preview },
            truthyFlag(flags, 'yes'),
            json,
            io,
          )
          if (gate !== null) return gate
          return emit(runTsCompliance(cfg, set), '合规记录已更新', '合规记录更新失败', json, io)
        }
        throw new UsageError(`compliance 只支持 get / set（收到：${verb}）。`)
      }
      case 'pack': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const args = {
          ...(typeof flags.out === 'string' && flags.out.trim() ? { out: flags.out } : {}),
          ...(typeof flags.lang === 'string' && flags.lang.trim() ? { lang: flags.lang } : {}),
        }
        const engineCfg = loadEngineConfigFor(cfg)
        const gameName = basename(engineCfg.gameDir || 'game').replace(/_prep$/, '')
        const gate = confirmWrite(
          `将生成补丁包 patch/${gameName}/（tl/${engineCfg.lang} 文件 + 角色名重定义补丁 + tav2-manifest.json 清单）`
          + `（打包前收尾对账 fail-closed：模板外残留将拒绝）。`,
          truthyFlag(flags, 'yes'),
          json,
          io,
        )
        if (gate !== null) return gate
        return emit(await runTsPack(cfg, args), '补丁打包完成', '补丁打包失败', json, io)
      }
      case 'deploy': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const target = positionals[1]
        if (!target) throw new UsageError('deploy <目标游戏目录> [--public]。')
        const isPublic = truthyFlag(flags, 'public')
        const engineCfg = loadEngineConfigFor(cfg)
        const gate = confirmWrite(
          `将复制 tl/${engineCfg.lang} → ${target}${isPublic ? '（公开部署，需 G-1 授权）' : '（本地自用）'}。`,
          truthyFlag(flags, 'yes'),
          json,
          io,
        )
        if (gate !== null) return gate
        return emit(runTsDeploy(cfg, target, { public: isPublic }), '部署完成', '部署失败', json, io)
      }
      case 'review': {
        requireProject()
        const cfg = cliConfig(projectDir, flags)
        const file = typeof flags.file === 'string' && flags.file.trim() ? flags.file : undefined
        if (!file) throw new UsageError('review --file <审校表.xlsx> [--force]。')
        const engineCfg = loadEngineConfigFor(cfg)
        const gate = confirmWrite(
          `将回填审校表 ${file} 到 tl/${engineCfg.lang}/（人工/机器译文写回 + 同步项目 DB 单元状态与 TM）${truthyFlag(flags, 'force') ? '（--force 忽略审校状态）' : ''}。`,
          truthyFlag(flags, 'yes'),
          json,
          io,
        )
        if (gate !== null) return gate
        const lines: string[] = []
        const log = (line: string) => { lines.push(line) }
        const outcome = await runTsReviewBackfill(
          undefined,
          cfg,
          { label: 'review', reviewFile: file, force: truthyFlag(flags, 'force') },
          log,
        )
        const ok = outcome.status === 'completed'
        return emit({ ok, text: [...lines, outcome.detail].join('\n') }, '审校回填完成', '审校回填失败', json, io)
      }
      case 'status': {
        requireProject()
        const result = runTsStatus(cliConfig(projectDir, flags))
        return emit(result, '项目状态总览', '项目状态读取失败', json, io)
      }
      case 'check': {
        requireProject()
        const result = runTsCheck(cliConfig(projectDir, flags))
        return emit(result, '完整性校验完成', '完整性校验未通过', json, io)
      }
      case 'verify': {
        requireProject()
        const result = runTsVerify(cliConfig(projectDir, flags))
        return emit(result, '运行验证完成', '运行验证未通过', json, io)
      }
      case 'report': {
        requireProject()
        const result = runTsReport(cliConfig(projectDir, flags))
        return emit(result, '项目报表', '项目报表生成失败', json, io)
      }
      case 'fingerprint': {
        const action = positionals[1] ?? 'check'
        if (action !== 'check' && action !== 'snapshot') {
          throw new UsageError(`fingerprint 的动作只能是 check 或 snapshot（收到：${action}）。`)
        }
        if (action === 'snapshot' && !truthyFlag(flags, 'yes')) {
          io.err(
            'fingerprint snapshot 是写操作（写 <项目>/fingerprint.json 与项目 DB）。\n'
            + '确认执行请加 --yes；只读比对请用 fingerprint check。',
          )
          return 4
        }
        requireProject()
        const result = runTsFingerprint(cliConfig(projectDir, flags), action)
        return emit(result, '版本指纹操作完成', '版本指纹操作失败', json, io)
      }
      case 'diff': {
        const from = positionals[1]
        const to = positionals[2]
        if (!from || !to) {
          throw new UsageError('diff 需要 <旧目录> <新目录> 两个位置参数，可选 --lang <语言>（默认 chinese）。')
        }
        const lang = typeof flags.lang === 'string' && flags.lang.trim() ? flags.lang.trim() : undefined
        const result = runTsDiff(cliConfig(projectDir, flags), {
          from: resolve(from),
          to: resolve(to),
          lang,
        })
        return emit(result, '差异对账完成', '差异对账失败', json, io)
      }
      case 'skill': {
        const verb = positionals[1] ?? 'print'
        if (verb !== 'print') {
          throw new UsageError(`skill 目前只支持 print（收到：${verb}）。`)
        }
        const bookletArg = typeof flags.booklet === 'string' ? flags.booklet.trim() : ''
        if (bookletArg) {
          const key = bookletArg.replace(/^renpy-/, '')
          const booklet = RENPY_BOOKLETS[key]
          if (!booklet) {
            throw new UsageError(
              `未知分册「${bookletArg}」。可用分册：${Object.keys(RENPY_BOOKLETS).join(' / ')}；缺省输出主流程。`,
            )
          }
          io.out(booklet.content)
          return 0
        }
        io.out(TAV2_WORKFLOW_CONTENT)
        return 0
      }
      case 'doctor': {
        const checks = await runDoctor({
          python: typeof flags.python === 'string' && flags.python.trim() ? flags.python.trim() : 'python',
          projectDir,
          hasProjectConfig: existsSync(join(projectDir, 'config.yaml')),
        }, { python: deps.pythonProbe })
        const mandatoryFailed = checks.filter((c) => !c.optional && !c.ok).length
        const optionalFailed = checks.filter((c) => c.optional && !c.ok).length
        const ok = mandatoryFailed === 0
        if (json) {
          io.out(JSON.stringify({ ok, checks }, null, 2))
        } else {
          const lines = checks.map((c) => {
            const mark = c.ok ? '✓' : c.optional ? '−' : '✗'
            return `${mark} ${c.name}${c.note ? ` — ${c.note}` : ''}`
          })
          const verdict = ok
            ? `自检结论：通过${optionalFailed > 0 ? `（${optionalFailed} 项可选未就绪）` : ''}`
            : `自检结论：${mandatoryFailed} 项必选未通过`
          io.out(['tav2kit doctor', ...lines, verdict].join('\n'))
        }
        return ok ? 0 : 1
      }
      default:
        throw new UsageError(`未知命令「${cmd}」。运行 tav2kit help 查看命令列表。`)
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message)
      return 2
    }
    io.err(`命令执行失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

/** bin 入口：仅在本文件被直接执行时运行（被 import 时不触发，便于测试与编程调用）。 */
export function main(): Promise<void> {
  const code = runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  })
  return code.then((c) => {
    process.exitCode = c
  })
}

// 直接执行检测：node dist/cli/main.js 时 argv[1] 指向本文件；被 import（测试/编程调用）时不相等。
try {
  const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
  if (invoked === import.meta.url) void main()
} catch {
  // 判定失败按「非直接执行」处理，不自动运行。
}
