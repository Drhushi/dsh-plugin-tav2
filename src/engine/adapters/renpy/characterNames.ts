/**
 * 角色显示名提取与翻译补丁（模板外残留收尾 · 人名侧）。
 *
 * 背景（两轮实机事故复盘）：Ren'Py 对 say 语句的 who 显示名不查字符串翻译表，
 * `Character("Robin")` 这类裸字符串定义在译文交付后仍是英文。唯一非侵入修法是
 * 生成 `translate <lang> python:` 块重定义 Character（切到该语言时执行赋值）。
 *
 * 三类形态分流：
 * - `__()`/`_()` 包裹名：延迟字符串翻译可覆盖（prepare 的 _() 扫描已提取），补丁不碰；
 * - 裸字符串名：字符串表救不了，必须重定义 → 有锁定译名的进补丁，没有的进收尾门禁；
 * - 动态名（None / 变量 / `[插值]` / label 内 `$` 运行时赋值）：只上报，不做补丁
 *   （init 级重定义会被运行时赋值覆盖，如 label 内 `$ mv = Character(...)`）。
 *
 * 只读解析 + 纯函数补丁文本生成；写盘由 pack（写操作工具）负责。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parsePythonStringLiteral } from './pystrings'

/** define/$ 赋值角色定义的语句头（语句体平衡括号截取）。 */
const CHAR_HEAD_RE = /^[ \t]*(define|\$)[ \t]+(\w+)[ \t]*=[ \t]*Character[ \t]*\(/

interface RawStatement {
  who: string
  /** define 或 $（$ 为运行时赋值，init 级重定义不可靠） */
  prefix: 'define' | '$'
  /** 语句全文（从头到平衡右括号，不含行首缩进） */
  statement: string
  file: string
  line: number
}

export interface CharacterNameEntry {
  who: string
  /** 显示名（已剥临时标签 {#...}） */
  name: string
  /** true = __()/_() 包裹（字符串翻译流程覆盖）；false = 裸字符串（需重定义补丁） */
  wrapped: boolean
  file: string
  line: number
  statement: string
}

export interface CharacterScan {
  entries: CharacterNameEntry[]
  dynamic: Array<{ who: string; file: string; line: number; reason: string }>
}

function collectRpyFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRpyFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.rpy')) out.push(full)
  }
  return out
}

/** 临时标签（如 {#player}）会残留进显示名。 */
const TEMP_TAG_IN_NAME_RE = /\{#[^}]*\}/g

function cleanName(name: string): string {
  return (name ?? '').replace(TEMP_TAG_IN_NAME_RE, '').trim()
}

/** 取首个顶层逗号之前的文本（第一个实参；字符串/括号感知）。 */
function firstArgText(args: string): string {
  let depth = 0
  let inStr: string | null = null
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!
    if (inStr) {
      if (ch === '\\') i += 1
      else if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") inStr = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return args.slice(0, i)
  }
  return args
}

/**
 * 从语句体（外层括号内文本）解析显示名。返回 null 表示动态/非字面名。
 */
function parseDisplayName(args: string): { name: string; wrapped: boolean } | null {
  // name= 关键字形态优先
  const kw = /\bname[ \t]*=[ \t]*/.exec(args)
  const rest = (kw ? firstArgText(args.slice(kw.index + kw[0].length)) : firstArgText(args)).trim()

  // __()/_() 包裹形态
  const wrappedMatch = /^(?:__|_)[ \t]*\(([\s\S]*)\)[ \t]*$/.exec(rest)
  if (wrappedMatch) {
    const value = parsePythonStringLiteral(wrappedMatch[1]!)
    if (value === null) return null
    return { name: value, wrapped: true }
  }
  // 裸字面量（含 _p 等其他前缀交给 parsePythonStringLiteral 判定）
  const value = parsePythonStringLiteral(rest)
  if (value === null) return null
  // Ren'Py 文本插值（[xxx]）是运行时求值，不属于可静态翻译的显示名
  if (/\[[^\]]+\]/.test(value)) return null
  return { name: value, wrapped: false }
}

/** 从语句文本中按平衡括号截取 `Character(...)` 的完整语句（支持多行）。 */
function extractStatement(lines: string[], startLine: number): { statement: string; endLine: number } | null {
  const head = CHAR_HEAD_RE.exec(lines[startLine] ?? '')
  if (!head) return null
  let depth = 0
  let inStr: string | null = null
  const collected: string[] = []
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i]!
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j]!
      if (inStr) {
        if (ch === '\\') j += 1
        else if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'") inStr = ch
      else if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          collected.push(line)
          return { statement: collected.join('\n').trim(), endLine: i }
        }
      }
    }
    collected.push(line)
    // 块结束保护：define 语句不允许引入新块（冒号收尾）
    if (depth === 0 && collected.length > 1) break
  }
  return null
}

/**
 * 扫描反编译脚本中的 Character 定义（跳过 tl/ 译文目录）。
 * gameDir 指向游戏根或 game/ 子目录均可。
 */
export function collectCharacterNameEntries(gameDir: string): CharacterScan {
  const gamedir = join(gameDir, 'game')
  const root = existsSync(gamedir) && statSync(gamedir).isDirectory() ? gamedir : gameDir
  const scan: CharacterScan = { entries: [], dynamic: [] }
  for (const p of collectRpyFiles(root).sort()) {
    const rel = relative(root, p).split(sep).join('/')
    if (rel.split('/').includes('tl')) continue
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const head = CHAR_HEAD_RE.exec(lines[i] ?? '')
      if (!head) continue
      const extracted = extractStatement(lines, i)
      if (!extracted) continue
      i = extracted.endLine
      const who = head[2]!
      const prefix = head[1] as 'define' | '$'
      const openIdx = extracted.statement.indexOf('(')
      const args = extracted.statement.slice(openIdx + 1, extracted.statement.lastIndexOf(')'))
      const parsed = parseDisplayName(args)
      if (prefix === '$') {
        scan.dynamic.push({ who, file: rel, line: i + 1, reason: '运行时赋值（label 内 $ 重定义会覆盖 init 级补丁）' })
        continue
      }
      if (!parsed) {
        scan.dynamic.push({ who, file: rel, line: i + 1, reason: '动态/非字面显示名（None、变量或 [插值]）' })
        continue
      }
      scan.entries.push({
        who,
        name: cleanName(parsed.name),
        wrapped: parsed.wrapped,
        file: rel,
        line: i + 1,
        statement: extracted.statement,
      })
    }
  }
  return scan
}

/** 在 define 语句中把显示名字面量替换为译名（保留包裹形态与全部其余参数）。 */
function replaceNameInStatement(statement: string, name: string, target: string): string {
  const escaped = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'")
  // name= 关键字形态：定位关键字后的第一个字面量
  const kw = /\bname[ \t]*=[ \t]*/.exec(statement)
  const searchFrom = kw ? kw.index + kw[0].length : statement.indexOf('(') + 1
  // 在 searchFrom 之后寻找第一个字符串字面量起点（跳过 _()/__() 包裹括号）
  for (let i = searchFrom; i < statement.length; i += 1) {
    const ch = statement[i]!
    if (ch !== '"' && ch !== "'") continue
    const quote = ch
    let j = i + 1
    let raw = ''
    while (j < statement.length && statement[j] !== quote) {
      if (statement[j] === '\\') { raw += statement[j]! + statement[j + 1]; j += 2; continue }
      raw += statement[j]
      j += 1
    }
    if (j >= statement.length) break
    if (raw === name) {
      return statement.slice(0, i) + quote + escaped + quote + statement.slice(j + 1)
    }
    break // 首个字面量不是目标名（防御：不乱替换）
  }
  return statement
}

export interface CharacterNamePatch {
  /** 完整补丁文件内容；无可译条目时为空串（不写文件） */
  content: string
  translated: string[]
  untranslated: string[]
}

/**
 * 生成 `translate <lang> python:` 角色重定义补丁。
 * - 只收裸字符串名；`__()` 包裹名与动态名不进补丁；
 * - define 语句在 python 块中转为赋值（`define ` 前缀剥除），仅替换名字面量，
 *   其余参数逐字保留；$ 语句原样保留前缀（但调用方不应给 $ 条目进补丁）。
 * translations：显示名 → 译名（来自锁定术语）。
 */
export function buildCharacterNamePatch(
  lang: string,
  entries: CharacterNameEntry[],
  translations: ReadonlyMap<string, string>,
): CharacterNamePatch {
  const patchable = entries.filter((e) => !e.wrapped)
  const translated: string[] = []
  const untranslated: string[] = []
  const body: string[] = []
  for (const entry of patchable) {
    const target = translations.get(entry.name)
    if (!target) {
      if (!untranslated.includes(entry.name)) untranslated.push(entry.name)
      continue
    }
    if (translated.includes(entry.name)) continue
    const rewritten = replaceNameInStatement(entry.statement, entry.name, target)
    const py = rewritten.replace(/^define[ \t]+/, '')
    for (const line of py.split('\n')) body.push(`    ${line}`)
    translated.push(entry.name)
  }
  if (body.length === 0) return { content: '', translated, untranslated }
  const header = [
    '# 由 tav2 生成：角色显示名按语言重定义（切到该语言时执行；切回原文自动还原）。',
    '# 非侵入契约：只新增 tl/<lang> 文件，不修改任何原游戏文件。删除本文件即还原。',
    `translate ${lang} python:`,
  ]
  return { content: [...header, ...body].join('\n') + '\n', translated, untranslated }
}
