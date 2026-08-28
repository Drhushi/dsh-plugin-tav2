/**
 * tav2_init：对话内初始化翻译项目（把最小 config.yaml 写进游戏根目录）。
 *
 * - 纯逻辑（可离线单测）：probeRenpyCandidates（只读扫候选）、buildInitConfigYaml、
 *   runTsInit（探测 + 就绪检查，只读）、runTsInitWrite（写盘）。
 * - 工具执行：需要写盘时先 ctx.approval 审批（预览路径 + 内容），批准后才落盘；
 *   落盘成功后把当前会话从「轻量引导」升级为「全套」翻译作用域（增量注册，不重复）。
 * - 探测复用 detectEngine；不指定目录时扫工作区直接子目录发现多个候选（agent 问用户选）。
 * - 非侵入契约：只新增 config.yaml，不改/覆盖任何游戏文件。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import type { Tav2ToolResult } from '../core/types'
import { detectEngine, renpyAdapter } from '../engine/adapters'
import { assertSupportedEngine, loadEngineConfig, resolveProjectDbPath } from '../engine/config'
import { ProjectDB } from '../engine/db'
import { upgradeAgentScopeToFull } from '../translation_scope'

export interface Tav2InitResult extends Tav2ToolResult {
  /** 探测到的候选游戏目录（不指定目录且扫到多个时返回，供 agent 问用户选）。 */
  candidates?: string[]
  /** 将写入/已存在的 config.yaml 路径。 */
  configPath?: string
  /** 是否还需要写盘（true = 走审批后写；false = 已就绪/无候选/报错）。 */
  needsWrite?: boolean
  /** 审批预览文本（需要写盘时提供，含路径与内容）。 */
  preview?: string
}

/** 只读扫描 root 及其直接子目录里的 Ren'Py 游戏目录（detectEngine 复用，不写盘）。 */
export function probeRenpyCandidates(root: string): string[] {
  const found: string[] = []
  try {
    const self = detectEngine(root)
    if (self.detected && self.engine === 'renpy') found.push(root)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const candidate = join(root, entry.name)
      const det = detectEngine(candidate)
      if (det.detected && det.engine === 'renpy') found.push(candidate)
    }
  } catch {
    return found
  }
  return found
}

/** 生成最小 config.yaml（engine: renpy + game_dir + lang: chinese）。 */
export function buildInitConfigYaml(gameDir: string): string {
  return [
    '# tav2 引擎配置（由 tav2_init 生成；可按需补充 style/fonts/runtime 等段）',
    'engine: renpy',
    `game_dir: ${gameDir}`,
    'lang: chinese',
    '',
  ].join('\n')
}

/**
 * 把用户输入的 game_dir 解析为可探测路径：
 * - 相对路径按会话工作区（agent cwd）解析为绝对路径（端用户习惯说相对路径）；
 * - 绝对路径 / 空值原样返回；无 baseCwd 时保持原样（回退进程 cwd 旧行为）。
 */
export function resolveInitTarget(target: string | undefined, baseCwd?: string): string | undefined {
  const t = (target ?? '').trim()
  if (!t) return undefined
  if (isAbsolute(t)) return t
  if (baseCwd && baseCwd.trim()) return join(baseCwd.trim(), t)
  return target
}

/** 探测 + 就绪检查（只读，不写盘）。 */
export function runTsInit(config: Config, target?: string, baseCwd?: string): Tav2InitResult {
  const root = (resolveInitTarget(target, baseCwd) ?? '').trim()
    || (config.gameDirOverride || config.projectDir || '').trim()
  if (!root) {
    return {
      ok: false,
      command: 'tav2_init',
      text: '未指定游戏目录，且工作区没有可探测目录。',
      timedOut: false,
      needsWrite: false,
    }
  }
  if (!existsSync(root)) {
    return {
      ok: false,
      command: 'tav2_init',
      text: `目录不存在：${root}`,
      timedOut: false,
      needsWrite: false,
    }
  }
  const configPath = join(root, 'config.yaml')
  // 已有 config.yaml → no-op（可能是配置目录/已初始化项目）。
  if (existsSync(configPath)) {
    return {
      ok: true,
      command: 'tav2_init',
      timedOut: false,
      configPath,
      needsWrite: false,
      text: `已就绪：${configPath} 已存在。直接跑 tav2_detect / tav2_status 确认项目，然后列翻译计划即可。`,
    }
  }
  let gameDir = root
  if (target && target.trim()) {
    const det = detectEngine(root)
    if (!det.detected || det.engine !== 'renpy') {
      return {
        ok: false,
        command: 'tav2_init',
        timedOut: false,
        needsWrite: false,
        text: `不是 Ren'Py 游戏目录：${root}（${det.message}）`,
      }
    }
  } else {
    const candidates = probeRenpyCandidates(root)
    if (candidates.length === 0) {
      return {
        ok: false,
        command: 'tav2_init',
        timedOut: false,
        needsWrite: false,
        text: `未发现 Ren'Py 游戏（已扫 ${root} 及其子目录）。请确认工作区包含游戏，或用 tav2_init <游戏目录> 直接指定。`,
      }
    }
    if (candidates.length > 1) {
      return {
        ok: true,
        command: 'tav2_init',
        timedOut: false,
        candidates,
        text: `发现 ${candidates.length} 个候选游戏，请先确认要初始化哪个，再用 tav2_init <游戏目录> 指定：\n${candidates.join('\n')}`,
      }
    }
    gameDir = candidates[0]!
  }
  const content = buildInitConfigYaml(gameDir)
  return {
    ok: true,
    command: 'tav2_init',
    timedOut: false,
    configPath: join(gameDir, 'config.yaml'),
    needsWrite: true,
    preview: `将新增配置文件：\n路径: ${join(gameDir, 'config.yaml')}\n内容:\n${content}\n确认初始化该翻译项目？（仅新增 config.yaml，不改任何游戏文件）`,
    text: `检测到 Ren'Py 游戏：${gameDir}。将生成最小 config.yaml（已请求审批）。`,
  }
}

/** 写盘生成 config.yaml（调用方需已通过审批）。已存在 → no-op 不覆盖。 */
export function runTsInitWrite(configPath: string): Tav2InitResult {
  if (existsSync(configPath)) {
    return {
      ok: true,
      command: 'tav2_init',
      timedOut: false,
      configPath,
      text: `已就绪：${configPath} 已存在，无需覆盖。`,
    }
  }
  const gameDir = dirname(configPath)
  if (!existsSync(gameDir)) {
    return { ok: false, command: 'tav2_init', timedOut: false, text: `目录不存在：${gameDir}` }
  }
  writeFileSync(configPath, buildInitConfigYaml(gameDir), 'utf8')
  return {
    ok: true,
    command: 'tav2_init',
    timedOut: false,
    configPath,
    text: `已生成 ${configPath}。下一步：跑 tav2_detect / tav2_status 确认项目 → 用 todo 列翻译计划 → 等确认后开始翻译。`,
  }
}

/** 摄入同步结果（tav2_init 完成后附带）。 */
export interface SyncExistingResult {
  ok: boolean
  /** 本次摄入（新增）的单元数。 */
  imported: number
  /** 文档中带已有 tl 译文（extra.translated）的单元数。 */
  translated: number
  /** 面向用户的说明文本（摄入失败时也返回，不抛异常）。 */
  text: string
}

/**
 * 从「游戏目录里已有的 tl 译文」摄入已译状态到项目 DB（初始化后自动调用）。
 * - 幂等：syncUnits 按 unit_id INSERT OR IGNORE，不覆盖已有状态；
 * - 失败不崩溃：无 config / 非 renpy / 提取失败一律返回 ok=false、摄入 0。
 */
export function syncExistingTranslations(configPath: string): SyncExistingResult {
  try {
    const engineCfg = loadEngineConfig(configPath, dirname(configPath))
    assertSupportedEngine(engineCfg)
    if (!engineCfg.gameDir) {
      return { ok: false, imported: 0, translated: 0, text: '未配置 game_dir，跳过已有译文摄入。' }
    }
    const extracted = renpyAdapter.extract(engineCfg.gameDir, { lang: engineCfg.lang })
    const document = extracted.document
    const db = new ProjectDB(resolveProjectDbPath(engineCfg, configPath, dirname(configPath)))
    try {
      const imported = db.syncUnits(document)
      const translated = document.allUnits().filter((u) => u.extra && u.extra.translated).length
      return {
        ok: true,
        imported,
        translated,
        text: `已摄入 ${imported} 条单元（其中 ${translated} 条已译，源自已有 tl/${engineCfg.lang} 译文）。`,
      }
    } finally {
      db.close()
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, imported: 0, translated: 0, text: `已有译文摄入失败（不影响初始化）：${detail}` }
  }
}

export function registerInitTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_init',
    description: '初始化翻译项目：探测/确认游戏目录（支持扫子目录发现多个候选），生成最小 config.yaml（engine: renpy + game_dir + lang: chinese）到游戏根目录并配置本会话工具；已有 config.yaml 时 no-op。',
    parameters: {
      game_dir: {
        type: 'string',
        description: '游戏根目录；省略时探测工作区及子目录（发现多个候选时返回列表，由 agent 询问用户）',
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
          candidates: { type: 'array', items: { type: 'string' } },
          configPath: { type: 'string' },
          needsWrite: { type: 'boolean' },
          preview: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2InitResult) => {
        const head = value.ok ? '翻译项目初始化' : '翻译项目初始化失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      const gameDir = typeof args.game_dir === 'string' ? args.game_dir : undefined
      // 会话工作区（agent cwd）：相对 game_dir 按它解析，端用户说相对路径不再报「目录不存在」。
      const cwd = (exec.agent as { session?: { header?: { cwd?: string } } } | null | undefined)
        ?.session?.header?.cwd
      const res = runTsInit(config, gameDir, cwd)
      let final: Tav2InitResult
      if (res.needsWrite) {
        const decision = await requestApproval(ctx, exec, res.preview ?? '确认初始化翻译项目？')
        if (decision !== 'allowed') {
          return {
            ok: false,
            command: 'tav2_init',
            timedOut: false,
            text: `${approvalDenialText(decision)}：未写入 config.yaml。`,
          }
        }
        const written = runTsInitWrite(res.configPath as string)
        if (written.ok && res.configPath) {
          // 本会话指向新生成的 config.yaml，并升级为全套翻译作用域。
          config.projectDir = dirname(res.configPath)
          config.engineConfigPath = ''
          config.gameDirOverride = undefined
          try {
            upgradeAgentScopeToFull(exec, config)
          } catch (err) {
            console.warn('[dsh-plugin-tav2] tav2_init 升级作用域失败：', err)
          }
        }
        final = written
      } else {
        final = res
      }
      // 初始化后摄入已有 tl 译文状态（新写与「已就绪」重跑均执行；幂等、失败不阻塞）。
      if (final.ok && final.configPath) {
        const sync = syncExistingTranslations(final.configPath)
        if (sync.imported > 0) {
          final = { ...final, text: `${final.text}\n${sync.text}` }
        }
      }
      return final
    },
  }))
}
