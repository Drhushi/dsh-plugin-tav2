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
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import type { Tav2ToolResult } from '../core/types'
import { detectEngine } from '../engine/adapters'
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

/** 探测 + 就绪检查（只读，不写盘）。 */
export function runTsInit(config: Config, target?: string): Tav2InitResult {
  const root = (target && target.trim()) || (config.gameDirOverride || config.projectDir || '').trim()
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
      const res = runTsInit(config, gameDir)
      if (!res.needsWrite) return res
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
      return written
    },
  }))
}
