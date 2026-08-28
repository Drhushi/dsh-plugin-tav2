/**
 * 模板外残留收尾对账（玩家可见文本全集 vs 翻译模板全集）。
 *
 * 绿门的覆盖率是对模板自身单元集算的（自指指标），模板外的玩家可见文本
 * （裸角色显示名、renpy.input 提示词等）漏译不会被发现——两轮实机事故复盘
 * 的共同根因。本模块把「源码里能扫到的模板外可见文本」与「字符串翻译表 +
 * 锁定术语」对账，产出收尾门禁结论与角色名重定义补丁。
 *
 * 只读解析 + 纯函数；写盘（补丁落 tl/<lang>）由 pack 等写操作工具负责。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseTlFile } from './tlparser'
import { collectCharacterNameEntries, buildCharacterNamePatch } from './characterNames'
import { scanInputPrompts } from './templates'

export interface ClosureIssue {
  kind: 'character-name' | 'input-prompt'
  detail: string
  file?: string
  line?: number
}

export interface ClosureResult {
  /** 是否真正完成了对账（找不到任何源码 .rpy 时为 false，门禁不拦但需提示） */
  audited: boolean
  characterNames: {
    total: number
    wrapped: number
    bare: number
    /** 裸名中已有锁定译名（pack 时会生成重定义补丁）的数量 */
    patchable: number
    /** 无锁定译名的裸显示名（去重） */
    untranslated: string[]
    dynamic: number
  }
  inputPrompts: {
    total: number
    covered: number
    missing: Array<{ old: string; file: string; line: number }>
  }
  /** pack 时写入 tl/<lang>/zzz_character_names.rpy 的内容；无可译条目时为空串 */
  characterNamePatch: string
  issues: ClosureIssue[]
  ok: boolean
}

export interface ClosureOptions {
  /** 反编译源码参考 game 目录（tav2_src/game 等）；取第一个存在且含 .rpy 的目录 */
  sourceGameDirs: string[]
  /** tl/<lang> 目录（字符串翻译表事实源） */
  tlDir: string
  lang: string
  /** 锁定术语（显示名 → 译名） */
  lockedTerms: Array<{ source: string; target: string }>
}

/** 收集 tl 目录下 strings 块的全部 old 串。 */
function collectTlOlds(tlDir: string, lang: string): Set<string> {
  const olds = new Set<string>()
  if (!existsSync(tlDir)) return olds
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile() || !entry.name.endsWith('.rpy')) continue
      try {
        for (const chunk of parseTlFile(full, lang)) {
          if (chunk.kind !== 'strings') continue
          for (const pair of chunk.pairs) if (pair.old) olds.add(pair.old)
        }
      } catch {
        // 单文件解析失败不阻断对账（verify 已另行报告格式问题）
      }
    }
  }
  walk(tlDir)
  return olds
}

/** 找出第一个含 .rpy 的源码目录；无则 null（无法对账）。 */
function pickSourceDir(sourceGameDirs: string[]): string | null {
  for (const dir of sourceGameDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    if (hasRpy(dir)) return dir
  }
  return null
}

function hasRpy(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.rpy')) return true
      if (entry.isDirectory() && entry.name !== 'tl' && hasRpy(join(dir, entry.name))) return true
    }
  } catch {
    return false
  }
  return false
}

export function evaluateClosure(opts: ClosureOptions): ClosureResult {
  const { tlDir, lang, lockedTerms } = opts
  const sourceDir = pickSourceDir(opts.sourceGameDirs)
  const issues: ClosureIssue[] = []
  const result: ClosureResult = {
    audited: sourceDir !== null,
    characterNames: { total: 0, wrapped: 0, bare: 0, patchable: 0, untranslated: [], dynamic: 0 },
    inputPrompts: { total: 0, covered: 0, missing: [] },
    characterNamePatch: '',
    issues,
    ok: true,
  }
  if (!sourceDir) return result

  // 人名侧：裸名需锁定译名（补丁），包裹名走字符串翻译流程，动态名只记账
  const scan = collectCharacterNameEntries(sourceDir)
  const translations = new Map(lockedTerms.map((t) => [t.source, t.target]))
  const bare = scan.entries.filter((e) => !e.wrapped)
  result.characterNames = {
    total: scan.entries.length,
    wrapped: scan.entries.length - bare.length,
    bare: bare.length,
    patchable: 0,
    untranslated: [],
    dynamic: scan.dynamic.length,
  }
  for (const entry of bare) {
    if (!translations.has(entry.name) && !result.characterNames.untranslated.includes(entry.name)) {
      result.characterNames.untranslated.push(entry.name)
      issues.push({
        kind: 'character-name',
        detail: `角色显示名 "${entry.name}"（${entry.file}:${entry.line}，裸字符串定义）未锁定译名`
          + '——请锁定术语后重试；字符串翻译表救不了它，Ren\'Py 不对说话人名查表',
        file: entry.file,
        line: entry.line,
      })
    }
  }
  const patch = buildCharacterNamePatch(lang, scan.entries, translations)
  result.characterNamePatch = patch.content
  result.characterNames.patchable = patch.translated.length

  // 提示词侧：renpy.input 提示必须已入 tl 字符串表（prepare 扫描写入 / 模板补入）
  const tlOlds = collectTlOlds(tlDir, lang)
  const prompts = scanInputPrompts(sourceDir)
  result.inputPrompts.total = prompts.length
  for (const prompt of prompts) {
    if (tlOlds.has(prompt.old)) {
      result.inputPrompts.covered += 1
    } else {
      result.inputPrompts.missing.push({ old: prompt.old, file: prompt.filename, line: prompt.linenumber })
      issues.push({
        kind: 'input-prompt',
        detail: `renpy.input 提示词 "${prompt.old}"（${prompt.filename}:${prompt.linenumber}）`
          + '未进入字符串翻译表——请重跑 prepare/模板补入后再试',
        file: prompt.filename,
        line: prompt.linenumber,
      })
    }
  }

  result.ok = issues.length === 0
  return result
}

/** 读 tl 目录字符串表（供工具层复用的轻封装）。 */
export function readTlStringOlds(tlDir: string, lang: string): Set<string> {
  return collectTlOlds(tlDir, lang)
}
