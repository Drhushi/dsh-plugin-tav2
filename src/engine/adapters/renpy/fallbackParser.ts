/**
 * 有限 .rpy 解析器：复刻 Ren'Py `Restructurer` 的翻译单元与标识符生成算法。
 *
 * 移植自 tav2/adapters/renpy/fallback_parser.py（保留算法与注释）。
 * 标识符算法与 renpy/translation/__init__.py 的 Restructurer 一致：
 * md5(每个语句 get_code() + "\r\n") 前 8 位，前缀为 label（点号转下划线）。
 * 本文件只用于产出 标识符 -> label 映射（extractRenpy 的场景分组），
 * 以及供测试校验标识符生成与 Python 基线一致。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { decodeString, findStringLiteral, STRING_PATTERN } from './compat'
import { DialogueUnit, SayLine } from './models'

const RECURSE_KEYWORDS = new Set(['label', 'menu', 'if', 'elif', 'else', 'init'])
const BLOCK_SKIP_KEYWORDS = new Set([
  'python',
  'while',
  'for',
  'screen',
  'transform',
  'image',
  'style',
  'layeredimage',
  'default',
  'define',
  // 游戏自带的 translate 块（语言文件 / 已有翻译）不是母语源文本：块体里的赋值
  // （gui.text_font = "..."）和译文 say 会被误当成对话单元（S17 噪声 + 待译队列污染）。
  'translate',
])
const TRANSLATABLE_RAW = new Set(['voice', 'voice sustain', 'nvl clear'])
const PLAIN_KEYWORDS = new Set([
  'show',
  'show layer',
  'camera',
  'hide',
  'scene',
  'with',
  'play',
  'stop',
  'queue',
  'window',
  'call',
  'jump',
  'return',
  'pass',
])

export class ParseError extends Error {}

type Stmt = [indent: number, text: string, line: number]
type GroupItem = ['raw' | 'say', string | SayLine, number]

/** 去掉行内 # 注释（字符串外），维护跨行三引号状态。 */
function stripComment(line: string, inTriple: string | null): { text: string; triple: string | null } {
  const out: string[] = []
  let triple = inTriple
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (triple) {
      out.push(c)
      if (c === triple && line.slice(i, i + 3) === triple + triple + triple) {
        if (!(i > 0 && line[i - 1] === '\\')) {
          out.push(line[i + 1]!)
          out.push(line[i + 2]!)
          i += 3
          triple = null
          continue
        }
      }
      i += 1
      continue
    }
    if (c === '#') break
    if (c === '"' || c === "'" || c === '`') {
      if (line.slice(i, i + 3) === c + c + c && !(i > 0 && line[i - 1] === '\\')) {
        out.push(line.slice(i, i + 3))
        triple = c
        i += 3
        continue
      }
      out.push(c)
      i += 1
      while (i < line.length) {
        out.push(line[i]!)
        if (line[i] === '\\' && i + 1 < line.length) {
          out.push(line[i + 1]!)
          i += 2
          continue
        }
        if (line[i] === c) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out.push(c)
    i += 1
  }
  return { text: out.join(''), triple }
}

/** 在指定位置匹配 Ren'Py 字符串字面量；不命中返回 null。 */
function matchStringAt(text: string, pos: number): string | null {
  STRING_PATTERN.lastIndex = pos
  const m = STRING_PATTERN.exec(text)
  if (m && m.index === pos) return m[0]
  return null
}

/** 统计字符串字面量之外的括号余额。 */
function bracketBalance(text: string): number {
  let balance = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === '`') {
      const m = matchStringAt(text, i)
      if (m) {
        i += m.length
        continue
      }
    }
    if (c === '(' || c === '[' || c === '{') balance += 1
    else if (c === ')' || c === ']' || c === '}') balance -= 1
    i += 1
  }
  return balance
}

/** 把 .rpy 文件读成 (缩进, 语句文本, 行号) 列表。 */
function readStatements(path: string): Stmt[] {
  const rawLines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split('\n')
  const statements: Stmt[] = []
  let current: [number, string[], number] | null = null
  let tripleState: string | null = null

  const flush = (): void => {
    if (current) {
      const [indent, parts, line] = current
      const text = parts.map((p) => p.trim()).join(' ').trim()
      if (text) statements.push([indent, text, line])
      current = null
    }
  }

  rawLines.forEach((raw, idx) => {
    const { text: stripped, triple } = stripComment(raw, tripleState)
    tripleState = triple
    if (current === null) {
      if (!stripped.trim()) return
      const indent = stripped.length - stripped.replace(/^[ \t]*/, '').length
      current = [indent, [stripped.trim()], idx + 1]
    } else {
      current[1].push(stripped.trim())
    }
    const text = current[1].join(' ').trim()
    if (tripleState === null && bracketBalance(text) <= 0) flush()
  })
  flush()
  return statements
}

/** 把语句拆成 (类型, 文本) 令牌：WORD / STR / PUNCT。 */
function tokenize(text: string): Array<[string, string]> {
  const tokens: Array<[string, string]> = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    const literal = matchStringAt(text, i)
    if (literal) {
      tokens.push(['STR', literal])
      i += literal.length
      continue
    }
    if (c === '(' || c === ')' || c === '@') {
      tokens.push(['PUNCT', c])
      i += 1
      continue
    }
    const STOP = '()@"\'`'
    let j = i
    while (j < text.length && !/\s/.test(text[j]!) && !STOP.includes(text[j]!)) j += 1
    tokens.push(['WORD', text.slice(i, j)])
    i = j
  }
  return tokens
}

/** 解析 say 语句为 SayLine（仅替换 what，结构与子句原样保留）。 */
function parseSay(text: string, line: number): SayLine {
  const tokens = tokenize(text)
  if (tokens.length === 0) throw new ParseError(`第 ${line} 行：空语句被当作 say 解析`)

  let who: string | null = null
  const attrs: string[] = []
  const temps: string[] = []
  let idx = 0

  if (tokens[0]![0] === 'STR') {
    if (tokens.length > 1 && tokens[1]![0] === 'STR') {
      // S17：字符串说话人（掩名）保留引号，避免写回成非法裸标识符行。
      who = tokens[0]![1]
      idx = 1
    }
  } else {
    who = tokens[0]![1]
    idx = 1
    let inTemp = false
    while (idx < tokens.length && tokens[idx]![0] !== 'STR') {
      if (tokens[idx]![0] === 'PUNCT') {
        // say 的 who/属性区只有词与 @；出现括号等标点说明是函数调用等表达式语句
        // （如 renpy.register_shader(...)），当 say 解析会产出非法说话人单元。
        if (tokens[idx]![1] !== '@') {
          throw new ParseError(`第 ${line} 行：who/属性区出现标点 ${tokens[idx]![1]}，非 say 语句`)
        }
        inTemp = true
      } else (inTemp ? temps : attrs).push(tokens[idx]![1])
      idx += 1
    }
  }

  if (idx >= tokens.length || tokens[idx]![0] !== 'STR') {
    throw new ParseError(`第 ${line} 行：未找到 say 的字符串字面量`)
  }
  const what = decodeString(tokens[idx]![1])
  const prefixParts: string[] = []
  if (who !== null) prefixParts.push(who)
  prefixParts.push(...attrs)
  if (temps.length) {
    prefixParts.push('@')
    prefixParts.push(...temps)
  }
  const suffixParts: string[] = []
  for (const [, value] of tokens.slice(idx + 1)) suffixParts.push(value)
  return new SayLine({
    who,
    what,
    prefix: prefixParts.join(' '),
    suffix: suffixParts.join(' '),
    raw: text,
    indent: '',
  })
}

function classify(text: string): string {
  const words = text.split(/\s+/)
  if (words.length === 0 || !words[0]) return 'plain'
  const first = words[0]!.replace(/:$/, '')
  if (words[0] === '$') return 'python'
  const two = words.length >= 2
    ? [words[0]!.replace(/:$/, ''), words[1]!.replace(/:$/, '')].join(' ')
    : first
  if (TRANSLATABLE_RAW.has(two) || TRANSLATABLE_RAW.has(first)) {
    return TRANSLATABLE_RAW.has(two) ? two : first
  }
  if (RECURSE_KEYWORDS.has(two) || RECURSE_KEYWORDS.has(first)) {
    return RECURSE_KEYWORDS.has(two) ? two : first
  }
  if (BLOCK_SKIP_KEYWORDS.has(two) || BLOCK_SKIP_KEYWORDS.has(first)) {
    return BLOCK_SKIP_KEYWORDS.has(two) ? two : first
  }
  if (PLAIN_KEYWORDS.has(first)) return first
  return 'say'
}

/** 判断是否为菜单选项行（字符串字面量开头且以冒号结束）。 */
function isChoice(text: string): boolean {
  const stripped = text.trimEnd()
  if (!stripped.endsWith(':')) return false
  return matchStringAt(stripped, 0) !== null
}

function parseLabel(text: string): { name: string; hide: boolean } {
  const rest = text.slice('label'.length).trim()
  const name = rest.split(/[\s(:]/, 1)[0]!
  const hide = rest.split(':')[0]!.split('(')[0]!.split(/\s+/).includes('hide')
  return { name, hide }
}

function parseMenuName(text: string): string | null {
  const rest = text.slice('menu'.length).trim()
  if (!rest) return null
  const first = rest.split(/\s+/, 1)[0]!
  if (first.endsWith(':')) return null
  return first.split('(')[0]!.replace(/:+$/, '')
}

/** 复刻 Restructurer：跨文件维护已用标识符，逐文件生成翻译单元。 */
export class RestructurerReplica {
  private defaultIds = new Set<string>()
  private units: DialogueUnit[] = []
  private warnings: string[] = []
  private skipped: Array<Record<string, unknown>> = []
  private menuChoices: Array<[string, number, string]> = []

  private scriptRoot = ''
  private fileRel = ''
  private preexisting = new Set<string>()
  private usedIds = new Set<string>()
  private label: string | null = null
  private alternate: string | null = null

  parseGame(gameDir: string): DialogueUnit[] {
    this.scriptRoot = gameDir
    for (const path of this.listRpyFiles(gameDir)) this.parseFile(path)
    return this.units
  }

  private listRpyFiles(gameDir: string): string[] {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const relParts = relative(gameDir, full).split(sep)
        if (relParts.includes('tl')) continue
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && (entry.name.endsWith('.rpy') || entry.name.endsWith('.rpym'))) {
          files.push(full)
        }
      }
    }
    walk(gameDir)
    files.sort((a, b) => {
      const ra = relative(gameDir, a).replace(/\.(rpy|rpym)$/i, '').split(sep).join('/')
      const rb = relative(gameDir, b).replace(/\.(rpy|rpym)$/i, '').split(sep).join('/')
      return ra.localeCompare(rb)
    })
    return files
  }

  private parseFile(path: string): void {
    const stmts = readStatements(path)
    this.fileRel = relative(this.scriptRoot, path).split(sep).join('/')
    this.preexisting = this.collectExplicitIds(stmts)
    this.usedIds = new Set()
    this.label = null
    this.alternate = null
    this.walk(stmts)
  }

  private collectExplicitIds(stmts: Stmt[]): Set<string> {
    const ids = new Set<string>()
    const visit = (level: Stmt[]): void => {
      let i = 0
      while (i < level.length) {
        const [, text, line] = level[i]!
        const kind = classify(text)
        if (kind === 'say') {
          try {
            const say = parseSay(text, line)
            if (say.explicitId) ids.add(say.explicitId)
          } catch {
            // 解析失败的语句跳过
          }
        }
        const block = this.children(level, i)
        if (block.length && RECURSE_KEYWORDS.has(kind)) visit(block)
        i = this.afterBlock(level, i)
      }
    }
    visit(stmts)
    return ids
  }

  private children(stmts: Stmt[], i: number): Stmt[] {
    const base = stmts[i]![0]
    let j = i + 1
    while (j < stmts.length && stmts[j]![0] > base) j += 1
    return stmts.slice(i + 1, j)
  }

  private afterBlock(stmts: Stmt[], i: number): number {
    const base = stmts[i]![0]
    let j = i + 1
    while (j < stmts.length && stmts[j]![0] > base) j += 1
    return j
  }

  private walk(stmts: Stmt[]): void {
    const group: GroupItem[] = []
    let i = 0
    while (i < stmts.length) {
      const [, text, line] = stmts[i]!
      const kind = classify(text)

      if (kind === 'if' || kind === 'elif' || kind === 'else') {
        this.walk(this.children(stmts, i))
        i = this.afterBlock(stmts, i)
        continue
      }

      if (kind === 'label') {
        const { name, hide } = parseLabel(text)
        if (!hide) {
          if (name.startsWith('_')) this.alternate = name
          else {
            this.label = name
            this.alternate = null
          }
        }
        this.walk(this.children(stmts, i))
        i = this.afterBlock(stmts, i)
        continue
      }

      if (kind === 'menu') {
        this.handleMenu(stmts, i, group)
        i = this.afterBlock(stmts, i)
        continue
      }

      if (kind === 'init') {
        // init [优先级] python: 块体是 Python 语句（config.x = "..."），不是 say；
        // 旧实现只匹配字面 `init python`，`init -2 python:` 会走进块体把赋值解析成对话。
        const words = text.replace(/:$/, '').split(/\s+/)
        const isInitPython = words.length > 0 && words[0] === 'init' && words.slice(1).includes('python')
        if (!isInitPython) this.walk(this.children(stmts, i))
        i = this.afterBlock(stmts, i)
        continue
      }

      if (BLOCK_SKIP_KEYWORDS.has(kind)) {
        this.skipped.push({ file: this.fileRel, line, kind: 'block_skip', statement: text.slice(0, 120) })
        i = this.afterBlock(stmts, i)
        continue
      }

      if (TRANSLATABLE_RAW.has(kind)) {
        group.push(['raw', text, line])
        i += 1
        continue
      }

      if (kind === 'say') {
        let say: SayLine
        try {
          say = parseSay(text, line)
        } catch (err) {
          if (group.length) {
            this.units.push(this.createUnit(group))
            group.length = 0
          }
          this.warnings.push(`${this.fileRel}:${line} 按普通语句处理：${String(err instanceof Error ? err.message : err)}`)
          this.skipped.push({ file: this.fileRel, line, kind: 'parse_fail', statement: text.slice(0, 120) })
          i += 1
          continue
        }
        group.push(['say', say, line])
        this.units.push(this.createUnit(group))
        group.length = 0
        i += 1
        continue
      }

      if (group.length) {
        this.units.push(this.createUnit(group))
        group.length = 0
      }
      i += 1
    }
    if (group.length) this.units.push(this.createUnit(group))
  }

  private handleMenu(stmts: Stmt[], i: number, group: GroupItem[]): void {
    const text = stmts[i]![1]
    const name = parseMenuName(text)
    if (name) {
      if (name.startsWith('_')) this.alternate = name
      else {
        this.label = name
        this.alternate = null
      }
    }
    const body = this.children(stmts, i)
    const firstChoice = body.findIndex((item) => isChoice(item[1]))
    const head = firstChoice === -1 ? body : body.slice(0, firstChoice)
    const choices = firstChoice === -1 ? [] : body.slice(firstChoice)

    let saySeen = false
    for (const [, btext, bline] of head) {
      const kind = classify(btext)
      if (kind === 'say' && !saySeen) {
        let say: SayLine
        try {
          say = parseSay(btext, bline)
        } catch {
          continue
        }
        if (say.who === null) continue
        if (!say.suffix.includes('nointeract')) say.suffix = `${say.suffix} nointeract`.trim()
        say.raw = say.render()
        group.push(['say', say, bline])
        this.units.push(this.createUnit(group))
        group.length = 0
        saySeen = true
      }
    }

    for (let idx = 0; idx < choices.length; idx += 1) {
      const item = choices[idx]!
      if (isChoice(item[1])) {
        const literal = matchStringAt(item[1], 0)
        if (literal) {
          try {
            this.menuChoices.push([this.fileRel, item[2], decodeString(literal)])
          } catch {
            // 解码失败忽略
          }
        }
        this.walk(this.children(choices, idx))
      }
    }

    if (group.length) {
      this.units.push(this.createUnit(group))
      group.length = 0
    }
  }

  private uniqueIdentifier(label: string | null, digest: string): string {
    const base = label === null ? digest : label.replace(/\./g, '_') + '_' + digest
    let i = 0
    for (;;) {
      const suffix = i === 0 ? '' : `_${i}`
      const candidate = base + suffix
      if (
        !this.usedIds.has(candidate)
        && !this.defaultIds.has(candidate)
        && !this.preexisting.has(candidate)
      ) {
        return candidate
      }
      i += 1
    }
  }

  private createUnit(group: GroupItem[]): DialogueUnit {
    const md5 = createHash('md5')
    for (const [kind, item] of group) {
      const code = kind === 'raw' ? item as string : (item as SayLine).raw
      md5.update(`${code}\r\n`)
    }
    const digest = md5.digest('hex').slice(0, 8)

    let idIdentifier: string | null = null
    for (const [kind, item] of group) {
      if (kind === 'say') {
        const explicit = (item as SayLine).explicitId
        if (explicit) idIdentifier = explicit
      }
    }

    const md5Identifier = this.uniqueIdentifier(this.label, digest)
    let identifier: string
    let alternate: string | null = null
    if (this.alternate !== null) {
      alternate = this.uniqueIdentifier(this.alternate, digest)
      identifier = idIdentifier ?? md5Identifier
    } else if (idIdentifier !== null) {
      alternate = md5Identifier
      identifier = idIdentifier
    } else {
      identifier = md5Identifier
    }

    this.usedIds.add(identifier)
    if (alternate !== null) this.usedIds.add(alternate)
    this.defaultIds.add(identifier)

    const sayLines = group.filter(([k]) => k === 'say').map(([, s]) => s as SayLine)
    const rawStatements = group.filter(([k]) => k === 'raw').map(([, s]) => s as string)
    const firstLine = group[0]![2]
    return new DialogueUnit({
      identifier,
      filename: this.fileRel,
      linenumber: firstLine,
      label: this.label,
      sayLines,
      rawStatements,
    })
  }
}

function gameDirRoot(path: string): string {
  const g = join(path, 'game')
  return existsSync(g) && statSync(g).isDirectory() ? g : path
}

/** 解析 game/ 下的脚本，返回全部对话翻译单元（模板兜底用）。 */
export function parseDialogueUnits(gameRoot: string): DialogueUnit[] {
  const scriptRoot = gameDirRoot(gameRoot)
  const replica = new RestructurerReplica()
  return replica.parseGame(scriptRoot)
}
