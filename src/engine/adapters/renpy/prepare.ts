/**
 * TS 原生 prepare 编排（目标「逐步替换 `python -m tav2 prepare` 调用点」的 TS 侧实现）。
 *
 * 职责：把「字符串扫描 → 对话解析（注入）→ 模板写出」串成单调用点 prepareTemplates。
 *
 * - 对话解析器以参数注入（对应并发 fallbackParser 的 parseDialogueUnits），本模块
 *   不 import 它，因此全离线可测（合成 DialogueUnit）。
 * - 支持 parseDir ≠ gameDir：归档游戏先由 M1 解包到临时覆盖层（parseDir），解析从
 *   覆盖层取 .rpy，模板仍写入真实游戏根 gameDir/tl/<lang>（非侵入契约：不覆盖游戏源）。
 * - 本模块不 unpack 归档（那是 M1 unpackRpaScripts 的职责），只做「解析 + 生成」。
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanFallbackStrings, writeFallbackTemplates, type TemplateMergeStats } from './templates'
import type { DialogueUnit } from './models'

/** 对话解析器签名（与 fallbackParser.parseDialogueUnits 一致）。 */
export type DialogueParser = (parseDir: string) => DialogueUnit[]

export interface TsPrepareOptions {
  /** 解析用目录（归档解包后的覆盖层）；缺省 = 解析用 gameDir（含 game/ 规范化）。 */
  parseDir?: string
}

export interface TsPrepareResult {
  /** 写出的模板绝对路径清单。 */
  templateFiles: string[]
  dialogueUnits: number
  stringUnits: number
  /** 幂等合并统计（重跑 prepare / 游戏自带 tl 时非空）：保留的已有已译块 / 追加的缺失块。 */
  merged?: { preservedBlocks: number; addedBlocks: number }
}

/**
 * 解析 Ren'Py 游戏目录：gameDir 若含 game/ 子目录则返回 game/，否则原样返回
 * （与 tlparser.tlRoot 的约定一致 —— tl/ 模板落在 <游戏>/tl/<lang>）。
 */
function resolveRenpyGameDir(gameDir: string): string {
  const g = join(gameDir, 'game')
  return existsSync(g) && statSync(g).isDirectory() ? g : gameDir
}

/**
 * 生成 tl/<lang> 翻译模板。返回写出的模板清单与单元计数。
 * - 模板写入解析后的游戏目录（含 game/ 子目录时落在 game/tl/<lang>，非侵入）。
 * - parseDir 缺省等于解析后的 gameDir；传入覆盖层（归档解包结果）时解析从覆盖层取。
 * 任一输入不可读/越界时抛错（fail-closed，不吞错）。
 */
export function prepareTemplates(
  gameDir: string,
  lang: string,
  parseDialogue: DialogueParser,
  opts: TsPrepareOptions = {},
): TsPrepareResult {
  const writeRoot = resolveRenpyGameDir(gameDir)
  const parseRoot = opts.parseDir ?? writeRoot
  const units = parseDialogue(parseRoot)
  const strings = scanFallbackStrings(parseRoot)
  const stats: TemplateMergeStats = { preservedBlocks: 0, addedBlocks: 0 }
  const templateFiles = writeFallbackTemplates(writeRoot, lang, units, strings, stats)
  return {
    templateFiles,
    dialogueUnits: units.length,
    stringUnits: strings.length,
    // 首次生成无保留块（preservedBlocks=0）时不带 merged；有合并时给出统计。
    merged: stats.preservedBlocks > 0
      ? { preservedBlocks: stats.preservedBlocks, addedBlocks: stats.addedBlocks }
      : undefined,
  }
}
