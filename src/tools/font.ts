/**
 * tav2_font：字体挑选与落地（TS 后端）。
 *
 * - list：枚举候选（游戏自带 / 系统已装 / 手动路径），读 TTF 元数据，CJK/版权启发式，来源去重；
 *   无任何候选时 fail-closed 明确提示（不静默）。
 * - pick：按候选 id（或绝对路径）挑字体 → 审批预览（写入文件清单 + 版权提醒 + 降级说明）→
 *   批准后复制字体到 tl/<lang>/font/、确认 gui 变量后生成样式覆盖 fonts.rpy、写 config fonts.default/map。
 * - 重复 pick 幂等替换（先清旧字体文件与覆盖）。非侵入契约：只写 tl/<lang> 与 config.yaml。
 */
import { existsSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import { approvalDenialText, requestApproval } from '../core/approval'
import { resolvePythonRepo } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { loadEngineConfigFor, resolveConfigPath } from '../engine/config'
import { enumerateFonts, type FontCandidate } from '../engine/fonts/scan'
import {
  applyFontPick,
  buildFontPickPlan,
  confirmGuiTextFont,
  readConfigFonts,
} from '../engine/fonts/patch'
import { resolveLang, sessionKeyOf } from './select_project'
import { resolveSourceGameDirs } from '../engine/adapters/renpy/sourceDir'
import { tsKnowledgeResult } from './tsKnowledge'

export type FontToolAction = 'list' | 'pick'

export interface FontToolArgs {
  action?: FontToolAction
  /** pick 目标：候选 id 或字体文件绝对路径。 */
  font?: string
  /** list：仅 CJK 候选（默认 true）。 */
  cjk_only?: boolean
  /** 额外手动字体目录（补充 config fonts.dir）。 */
  dir?: string
}

export interface FontCandidateView {
  id: string
  name: string
  source: FontCandidate['source']
  path: string
  family?: string
  weight?: number
  copyright?: string
  cjk: boolean
  risky: boolean
  metaOk: boolean
  ext: string
}

export interface FontListView {
  lang: string
  currentDefault?: string
  candidates: FontCandidateView[]
}

export interface FontPickView {
  id: string
  name: string
  source: FontCandidate['source']
  path: string
  lang: string
  fontFile: string
  fontPath: string
  rpyPath: string
  risky: boolean
  degraded?: boolean
  files?: string[]
}

export interface Tav2FontResult extends Tav2ToolResult {
  needsWrite?: boolean
  preview?: string
  fonts?: FontListView | FontPickView
}

function configPathOf(config: Config): string {
  return resolveConfigPath(config.engineConfigPath || config.configPath, config.projectDir)
}

/** 枚举候选（合并 config fonts.dir 与每调用 dir；不过滤，由调用方按需过滤）。 */
function enumerateFor(config: Config, args: FontToolArgs): FontCandidate[] {
  const engineCfg = loadEngineConfigFor(config)
  const dir = (args.dir && args.dir.trim()) || engineCfg.fonts.dir || undefined
  return enumerateFonts(engineCfg.gameDir, {
    dir,
    includeSystem: true,
  })
}

function toView(c: FontCandidate): FontCandidateView {
  return {
    id: c.id,
    name: c.name,
    source: c.source,
    path: c.path,
    ...(c.family ? { family: c.family } : {}),
    ...(c.weight !== undefined ? { weight: c.weight } : {}),
    ...(c.copyright ? { copyright: c.copyright } : {}),
    cjk: c.cjk,
    risky: c.risky,
    metaOk: c.metaOk,
    ext: c.ext,
  }
}

/** list：只读，不写盘。 */
export function runTsFontList(config: Config, args: FontToolArgs, sessionKey?: string): Tav2FontResult {
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (!engineCfg.gameDir) {
      return tsKnowledgeResult('tav2_font list 需要 config.yaml 配置 game_dir（先 tav2_init 初始化项目）', false)
    }
    const lang = resolveLang(config, sessionKey)
    const all = enumerateFor(config, args)
    const cjkOnly = args.cjk_only !== false
    const candidates = cjkOnly ? all.filter((c) => c.cjk) : all
    if (all.length === 0) {
      const manualHint = (args.dir && args.dir.trim()) ? args.dir : engineCfg.fonts.dir || 'config.yaml 的 fonts.dir'
      return {
        ...tsKnowledgeResult(
          `未发现任何字体候选（已扫：游戏目录 + 系统字体 + 手动路径 ${manualHint}）。\n`
          + '请把字体文件放进游戏目录、或在 config.yaml 的 fonts.dir（或 tav2_font list dir=...）指定字体目录；联网下载源在二期。',
          false,
        ),
        fonts: { lang, candidates: [] },
      }
    }
    if (cjkOnly && candidates.length === 0) {
      return {
        ...tsKnowledgeResult(
          `未发现 CJK 中文字体候选（当前找到 ${all.length} 个字体但均按启发式判为非 CJK，已按 CJK 过滤）。`
          + '用 cjk_only=false 可查看全部；或补充中文字体后重试。',
        ),
        fonts: { lang, candidates: [] },
      }
    }
    const current = readConfigFonts(configPathOf(config))
    const sourceLabel: Record<string, string> = { game: '游戏', system: '系统', manual: '手动' }
    const lines = [
      `tav2 字体候选（lang=${lang}，共 ${candidates.length} 个；当前默认：${current.default ?? '未选择'}）：`,
      ...candidates.map((c, i) => {
        const parts = [
          `${i + 1}) ${c.name}`,
          `id=${c.id}`,
          `来源=${sourceLabel[c.source]}`,
          c.cjk ? 'CJK ✓' : 'CJK ✗',
          c.weight !== undefined ? `字重=${c.weight}` : '',
          c.risky ? '⚠️ 版权风险' : '',
          c.metaOk ? '' : '（元数据不可读）',
        ].filter(Boolean).join(' · ')
        const detail = `    路径: ${c.path}${c.copyright ? `\n    版权: ${c.copyright.slice(0, 120)}` : ''}`
        return `${parts}\n${detail}`
      }),
      '挑选：tav2_font pick <id>',
    ]
    return { ...tsKnowledgeResult(lines.join('\n')), fonts: { lang, ...(current.default ? { currentDefault: current.default } : {}), candidates: candidates.map(toView) } }
  } catch (err) {
    return tsKnowledgeResult(`字体列表失败：${String(err instanceof Error ? err.message : err)}`, false)
  }
}

/** 找候选：优先按 id，其次按绝对路径匹配。 */
function findCandidate(candidates: FontCandidate[], font: string): FontCandidate | undefined {
  const byId = candidates.find((c) => c.id === font)
  if (byId) return byId
  if (isAbsolute(font)) {
    const resolved = resolve(font)
    return candidates.find((c) => c.path === resolved)
  }
  return undefined
}

/**
 * 编译版游戏的反编译源码目录（gui 变量确认用）。
 * 新约定：<游戏根>/tav2_src/game（prepare 重构后源码参考随游戏根存放）；
 * 兼容旧链路：game_dir 指向旧暂存根（<名>_prep）时其自身 game/ 即源码，
 * 以及插件 python 仓库 work/<游戏名>_prep/game。无任何候选时返回空。
 */
export function prepSourceDirs(config: Config, gameDir: string): string[] {
  const dirs = resolveSourceGameDirs(gameDir)
  if (gameDir && /_prep$/.test(basename(gameDir))) {
    const ownGame = join(gameDir, 'game')
    if (existsSync(ownGame)) dirs.push(ownGame)
  }
  const repo = resolvePythonRepo(config)
  if (repo && gameDir) {
    const stagingGame = join(repo, 'work', `${basename(gameDir)}_prep`, 'game')
    if (existsSync(stagingGame)) dirs.push(stagingGame)
  }
  return dirs
}

/** pick：只读规划 + 审批预览（不写盘）。 */
export function runTsFontPick(config: Config, args: FontToolArgs, sessionKey?: string): Tav2FontResult {
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (!engineCfg.gameDir) {
      return tsKnowledgeResult('tav2_font pick 需要 config.yaml 配置 game_dir', false)
    }
    if (!args.font) return tsKnowledgeResult('请指定要挑选的字体：tav2_font pick <id>（id 见 tav2_font list）', false)
    const lang = resolveLang(config, sessionKey)
    const candidates = enumerateFor(config, args)
    const hit = findCandidate(candidates, args.font)
    if (!hit) {
      const ids = candidates.slice(0, 20).map((c) => c.id).join(' / ') || '（无候选）'
      return tsKnowledgeResult(`未找到字体「${args.font}」。可用候选：${ids}`, false)
    }
    if (!existsSync(hit.path)) {
      return tsKnowledgeResult(`候选文件不存在：${hit.path}`, false)
    }
    const configPath = configPathOf(config)
    const plan = buildFontPickPlan(engineCfg.gameDir, configPath, hit.path, lang)
    const confirmVars = confirmGuiTextFont(engineCfg.gameDir, prepSourceDirs(config, engineCfg.gameDir))
    const lines = [
      `将应用字体「${plan.name}」（id=${hit.id}，来源=${hit.source}）到 tl/${lang}/font/：`,
      `  写入字体: ${plan.fontPath}`,
      confirmVars ? `  写入样式覆盖: ${plan.rpyPath}` : '  ⚠️ 未确认 gui.text_font → 只复制字体，不写样式覆盖（见 RENPY-LANGUAGE-SWITCH-RECIPE）',
      `  更新 config: ${plan.configPath}`,
      '  fonts 段将变为：',
      ...plan.configBlock.split('\n').map((l) => `    ${l}`),
      plan.replaces.length > 0 ? `  将替换旧文件：${plan.replaces.map((f) => f.split(/[\\/]/).pop()).join('、')}` : '',
      plan.risky ? '⚠️ 版权提醒：该字体可能不允许再分发（如微软雅黑/宋体等系统字体），默认放行；请自行确认许可，勿用于公开分发。' : '',
      '确认应用？',
    ].filter(Boolean).join('\n')
    const view: FontPickView = {
      id: hit.id,
      name: plan.name,
      source: hit.source,
      path: hit.path,
      lang,
      fontFile: plan.fontFile,
      fontPath: plan.fontPath,
      rpyPath: plan.rpyPath,
      risky: plan.risky,
    }
    return { ok: true, command: 'font pick', text: lines, timedOut: false, needsWrite: true, preview: lines, fonts: view }
  } catch (err) {
    return tsKnowledgeResult(`字体挑选失败：${String(err instanceof Error ? err.message : err)}`, false)
  }
}

/** pick 写盘（调用方需已通过审批）。 */
export function runTsFontPickWrite(config: Config, args: FontToolArgs, sessionKey?: string): Tav2FontResult {
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (!engineCfg.gameDir) return tsKnowledgeResult('tav2_font pick 需要 config.yaml 配置 game_dir', false)
    if (!args.font) return tsKnowledgeResult('缺少字体 id', false)
    const lang = resolveLang(config, sessionKey)
    const candidates = enumerateFor(config, args)
    const hit = findCandidate(candidates, args.font)
    if (!hit || !existsSync(hit.path)) {
      return tsKnowledgeResult(`候选不存在：${args.font}（可能已被移动，重新 tav2_font list 确认）`, false)
    }
    const configPath = configPathOf(config)
    const plan = buildFontPickPlan(engineCfg.gameDir, configPath, hit.path, lang)
    const confirmVars = confirmGuiTextFont(engineCfg.gameDir, prepSourceDirs(config, engineCfg.gameDir))
    const applied = applyFontPick(plan, confirmVars)
    const view: FontPickView = {
      id: hit.id,
      name: plan.name,
      source: hit.source,
      path: hit.path,
      lang,
      fontFile: plan.fontFile,
      fontPath: plan.fontPath,
      rpyPath: plan.rpyPath,
      risky: plan.risky,
      degraded: applied.degraded,
      files: applied.files,
    }
    const lines = [
      `已应用字体「${plan.name}」（id=${hit.id}）→ tl/${lang}/font/`,
      `  字体: ${plan.fontPath}`,
      applied.degraded ? `  ${applied.note}` : `  样式覆盖: ${plan.rpyPath}`,
      `  config fonts.default=${plan.values.default}`,
      plan.risky ? '⚠️ 版权提醒：该字体可能不允许再分发（默认放行，请自行确认许可）。' : '',
      '下一步：tav2_verify 核对字体就位；实机启动游戏确认设置→语言菜单中文无方框。',
    ].filter(Boolean).join('\n')
    return { ...tsKnowledgeResult(lines), fonts: view }
  } catch (err) {
    return tsKnowledgeResult(`字体应用失败：${String(err instanceof Error ? err.message : err)}`, false)
  }
}

export function registerFontTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_font',
    description: '字体挑选与落地：list 枚举候选（游戏自带/系统已装/手动路径，读 TTF 元数据 + CJK/版权启发式）；'
      + 'pick <id> 复制字体到 tl/<lang>/font/、确认 gui 变量后生成样式覆盖 fonts.rpy、写 config fonts.default/map（写操作需审批，重复 pick 幂等替换）。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'pick'],
        description: 'list=枚举候选（只读）；pick=挑选并落地（写操作）',
      },
      font: {
        type: 'string',
        description: 'pick 目标：候选 id（见 list）或字体文件绝对路径',
      },
      cjk_only: {
        type: 'boolean',
        description: 'list 仅显示 CJK 候选（默认 true）',
      },
      dir: {
        type: 'string',
        description: '额外手动字体目录（补充 config fonts.dir）',
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
          needsWrite: { type: 'boolean' },
          preview: { type: 'string' },
          fonts: {
            type: 'object',
            description: '结构化结果：list=候选列表；pick=落地信息',
            properties: {
              lang: { type: 'string' },
              currentDefault: { type: 'string' },
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    source: { type: 'string' },
                    path: { type: 'string' },
                    family: { type: 'string' },
                    weight: { type: 'number' },
                    copyright: { type: 'string' },
                    cjk: { type: 'boolean' },
                    risky: { type: 'boolean' },
                    metaOk: { type: 'boolean' },
                    ext: { type: 'string' },
                  },
                  additionalProperties: false,
                },
              },
              id: { type: 'string' },
              name: { type: 'string' },
              source: { type: 'string' },
              path: { type: 'string' },
              fontFile: { type: 'string' },
              fontPath: { type: 'string' },
              rpyPath: { type: 'string' },
              risky: { type: 'boolean' },
              degraded: { type: 'boolean' },
              files: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const head = value.ok ? 'tav2 字体' : 'tav2 字体失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
    },
    async execute(args: FontToolArgs, exec) {
      const sessionKey = sessionKeyOf(exec)
      const action = args.action ?? 'list'
      if (action === 'list') return runTsFontList(config, args, sessionKey)
      const res = runTsFontPick(config, args, sessionKey)
      if (!res.ok || !res.needsWrite) return res
      const decision = await requestApproval(ctx, exec, res.preview ?? '确认应用所选字体？')
      if (decision !== 'allowed') {
        return { ok: false, command: '', text: `${approvalDenialText(decision)}：未写入任何文件。`, timedOut: false }
      }
      return runTsFontPickWrite(config, args, sessionKey)
    },
  }))
}
