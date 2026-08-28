/**
 * tav2_verify：运行验证（G5 程序侧）——格式（G0）、覆盖对账（G1）、
 * CJK 字体检查与启动截图核对指引。对应施工规划 §6 的 tx_verify；
 * 实际启动游戏与截图核验是人工步骤，本工具产出检查结论与指引。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { verifyRenpy } from '../engine/adapters/renpy/verify'
import { renpyAdapter } from '../engine/adapters'
import type { RuntimeCheck, RuntimeRequirement } from '../engine/adapters'
import { summarizeRuntime } from '../engine/runtime/summary'
import { loadEngineConfigFor, resolveProjectDbPath } from '../engine/config'
import { tlRoot } from '../engine/adapters/renpy/tlparser'
import { isCjkFont, sanitizeStem } from '../engine/fonts/scan'
import { STYLE_OVERRIDE_FILE } from '../engine/fonts/patch'
import { ProjectDB } from '../engine/db'
import { tsKnowledgeResult } from './tsKnowledge'
import { tav2RuntimeModeJsonSchema, tav2RuntimeRequirementsJsonSchema } from './status'
import { verifyMeta } from '../present/meta'

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc']

/** tav2_verify 的结构化检查结果。 */
export interface Tav2VerifyResult extends Tav2ToolResult {
  verify?: {
    engine: string
    format: { missingBlocks: number; tagViolations: number; engineNote: string }
    coverage: { extractedUnits: number; translatedUnits: number; missingUnits: number }
    fonts: { checked: boolean; found: boolean; warnings: string[] }
    guide: string
    /** 运行时三层结论（文件层 / 运行时层 / 实机确认），由适配器 runtime 提供。 */
    runtime?: {
      mode: { kind: string; translationDir: string | null; note: string } | null
      fileLayer: 'ok' | 'warn' | 'fail'
      runtimeLayer: 'ok' | 'unverified' | 'warn' | 'fail'
      manualLayer: boolean
      checks: RuntimeCheck[]
      requirements: RuntimeRequirement[]
    }
  }
}

/** 在目录（存在时）内查找字体文件。 */
function findFontFiles(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((name) => FONT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
  } catch {
    return []
  }
}

/** 判断字体文件集合中是否含中文 CJK 字体（与 tav2_font 同一启发式）。 */
function hasCjkFont(files: string[]): boolean {
  return files.some((name) => isCjkFont(name))
}

/** engineBackend=ts：运行验证（仅 Ren'Py）。 */
export function runTsVerify(config: Config): Tav2VerifyResult {
  if (config.engineBackend === 'python') {
    return {
      ok: false,
      command: '',
      text: 'engineBackend=python：tav2_verify 仅 TS 后端支持，请改用 engineBackend=ts。',
      timedOut: false,
    }
  }

  let db: ProjectDB | null = null
  try {
    const engineCfg = loadEngineConfigFor(config)
    if (!engineCfg.gameDir) {
      return tsKnowledgeResult('验证失败：config.yaml 未配置 game_dir', false)
    }

    // ---- 格式（G0）----
    type VerifyFormat = NonNullable<Tav2VerifyResult['verify']>['format']
    let format: VerifyFormat
    let missingBlocks = 0
    let tagViolations = 0
    let engineNote = ''
    try {
      const report = verifyRenpy(engineCfg.gameDir, engineCfg.lang)
      missingBlocks = report.missing_blocks
      tagViolations = report.tag_violations
    } catch (err) {
      engineNote = `格式校验失败：${String(err instanceof Error ? err.message : err)}`
    }
    format = { missingBlocks, tagViolations, engineNote }

    // ---- 覆盖对账（G1）：提取文档 vs DB 已译 ----
    const document = renpyAdapter.extract(engineCfg.gameDir, { lang: engineCfg.lang }).document
    const extractedUnits = document.allUnits().length
    db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
    const stats = db.unitStats()
    const translatedUnits = stats.translated ?? 0
    const coverage = {
      extractedUnits,
      translatedUnits,
      missingUnits: Math.max(0, extractedUnits - translatedUnits),
    }

    // ---- 字体（G5 程序侧）：fonts.dir 与游戏目录启发式检查 + 选中字体确认（AC5）----
    const warnings: string[] = []
    const fontsCfg = engineCfg.fonts
    const searchDirs = [...new Set([
      fontsCfg.dir,
      join(engineCfg.gameDir, 'game'),
      engineCfg.gameDir,
    ].filter(Boolean))]
    const fontFiles = [...new Set(searchDirs.flatMap((dir) => findFontFiles(dir)))]

    // fonts.default 已设时：确认 tl/<lang>/font 下选中字体 + 样式覆盖 fonts.rpy 就位；缺失给 warning。
    let selectedFound = false
    if (fontsCfg.enabled && fontsCfg.default) {
      const tlFontDir = join(tlRoot(engineCfg.gameDir, engineCfg.lang), 'font')
      const selFiles = findFontFiles(tlFontDir)
      selectedFound = selFiles.some((f) => sanitizeStem(f) === fontsCfg.default)
      if (!selectedFound) {
        warnings.push(`config fonts.default=${fontsCfg.default} 但未在 tl/${engineCfg.lang}/font 找到对应字体文件（用 tav2_font pick 选择并落地）`)
      } else {
        const rpyOk = existsSync(join(tlFontDir, STYLE_OVERRIDE_FILE))
        if (!rpyOk) {
          warnings.push(`字体文件就位但未找到样式覆盖 tl/${engineCfg.lang}/font/${STYLE_OVERRIDE_FILE}（选中字体未生成覆盖，需重新 tav2_font pick 或按 RENPY-LANGUAGE-SWITCH-RECIPE 手动接入）`)
        }
      }
    }

    const cjkFound = hasCjkFont(fontFiles) || fontFiles.length > 0 || selectedFound
    if (fontsCfg.enabled && !cjkFound) {
      warnings.push('未在 fonts.dir 或游戏目录发现中文字体文件，启动后可能出现方框；请补字体，或在项目 config.yaml 的 fonts.dir 配置字体目录')
    }
    const fonts = { checked: true, found: cjkFound, warnings }

    // ---- 指引（G5 人工部分）----
    const guide = [
      '启动方式：运行游戏（<游戏名>.exe，或 Ren\'Py 启动器选择项目）。',
      '核对清单：1) 标题与按钮无方框（CJK 字体生效） 2) 对话文本正常显示 3) 抽查 20 个画面无乱码/漏翻 4) 文本标签（{b}/{size} 等）未被渲染成字面文本。',
      '发现方框/乱码：补字体（fonts.dir 或运行时替换），重跑本工具复查。',
    ].join('\n')

    // ---- 运行时层（适配器 runtime）：部署形态 + canary + 伴侣组件自检 ----
    const runtimeAdapter = renpyAdapter
    const rt = runtimeAdapter.runtime
    let runtimeView: NonNullable<Tav2VerifyResult['verify']>['runtime']
    if (rt) {
      const summary = summarizeRuntime(rt, engineCfg.gameDir, engineCfg.lang, engineCfg.runtime)
      const fileLayer: 'ok' | 'warn' | 'fail' =
        (format.missingBlocks > 0 || format.tagViolations > 0) || !cjkFound ? 'warn' : 'ok'
      runtimeView = { mode: summary.mode, fileLayer, runtimeLayer: summary.runtimeLayer, manualLayer: true, checks: summary.checks, requirements: summary.requirements }
    }

    const runtimeLines: string[] = []
    if (runtimeView) {
      const layerLabel: Record<string, string> = {
        ok: '✅ 日志证据充分（运行时已加载并读到译文缓存）',
        unverified: '⚠️ 未验证（缺少运行日志证据，请先启动游戏再重跑）',
        warn: '⚠️ 存在告警（见下方运行时检查）',
        fail: '❌ 确定不生效（见下方运行时检查）',
      }
      runtimeLines.push(`运行时层：${layerLabel[runtimeView.runtimeLayer]}`)
      runtimeLines.push(`  模式：${runtimeView.mode?.kind ?? 'unknown'}${runtimeView.mode?.translationDir ? `（${runtimeView.mode.translationDir}）` : ''}`)
      for (const r of runtimeView.requirements) {
        runtimeLines.push(`  运行时组件 ${r.name}：${r.installed ? '已安装' : '缺失 ⚠️'}${r.doc ? `（${r.doc}）` : ''}`)
      }
      const missingReqs = runtimeView.requirements.filter((r) => !r.installed)
      if (missingReqs.length > 0) {
        runtimeLines.push('  提示：缺失的运行时组件（如 CJK 字体）请在项目 config.yaml 的 runtime.requirements 声明路径后重跑。')
      }
      for (const c of runtimeView.checks) {
        const tag = c.level === 'error' ? '❌' : c.level === 'warn' ? '⚠️' : '·'
        runtimeLines.push(`  ${tag} ${c.title}：${c.detail}`)
      }
      runtimeLines.push('实机确认：待用户启动游戏核对对话/字体显示')
    }

    const verify: Tav2VerifyResult['verify'] = { engine: engineCfg.engine, format, coverage, fonts, guide, runtime: runtimeView }
    const text = [
      `引擎：${engineCfg.engine} / ${engineCfg.lang}`,
      `格式（G0）：缺失块 ${format.missingBlocks} / 标签违规 ${format.tagViolations}${format.engineNote ? `（${format.engineNote}）` : ''}`,
      `覆盖（G1）：提取 ${coverage.extractedUnits} 单元，已译 ${coverage.translatedUnits}，缺失 ${coverage.missingUnits}`,
      `字体（G5）：${cjkFound ? '已发现字体文件' : '未发现中文字体'}${warnings.length > 0 ? `（${warnings.join('；')}）` : ''}`,
      ...runtimeLines,
      '运行指引：',
      guide,
    ].join('\n')
    return { ...tsKnowledgeResult(text), verify }
  } catch (err) {
    return tsKnowledgeResult(`验证失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    db?.close()
  }
}

export function registerVerifyTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_verify',
    description: '运行验证：格式（G0）、覆盖对账（G1）、CJK 字体检查与启动截图核对指引（G5 程序侧，engineBackend=ts）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          verify: {
            type: 'object',
            description: '结构化验证结果（engineBackend=ts 时返回）',
            properties: {
              engine: { type: 'string' },
              format: {
                type: 'object',
                properties: {
                  missingBlocks: { type: 'number' },
                  tagViolations: { type: 'number' },
                  engineNote: { type: 'string' },
                },
                additionalProperties: false,
              },
              coverage: {
                type: 'object',
                properties: {
                  extractedUnits: { type: 'number' },
                  translatedUnits: { type: 'number' },
                  missingUnits: { type: 'number' },
                },
                additionalProperties: false,
              },
              fonts: {
                type: 'object',
                properties: {
                  checked: { type: 'boolean' },
                  found: { type: 'boolean' },
                  warnings: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
              },
              guide: { type: 'string' },
              runtime: {
                type: 'object',
                description: '运行时三层结论（部署形态 + canary + 伴侣组件自检）',
                properties: {
                  mode: tav2RuntimeModeJsonSchema,
                  fileLayer: { type: 'string', enum: ['ok', 'warn', 'fail'] },
                  runtimeLayer: { type: 'string', enum: ['ok', 'unverified', 'warn', 'fail'] },
                  manualLayer: { type: 'boolean' },
                  checks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string' }, level: { type: 'string', enum: ['info', 'warn', 'error'] }, ok: { type: 'boolean' }, detail: { type: 'string' } } } },
                  requirements: tav2RuntimeRequirementsJsonSchema,
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2VerifyResult) => {
        const head = value.ok ? 'tav2 运行验证' : 'tav2 运行验证失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => verifyMeta(_args, value),
    },
    async execute(_args, _exec) {
      return runTsVerify(config)
    },
  }))
}
