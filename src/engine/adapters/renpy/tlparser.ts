/**
 * 解析 / 重建 tl/<语言>/*.rpy 翻译文件。
 * 移植自 tav2 的 adapters/renpy/tlparser.py（保留语义与注释）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { decodeString, ensureTranslationTag, quoteUnicode, unquoteUnicode } from './compat'
import { DialogueUnit, SayLine, StringUnit } from './models'
import type { TlChunk } from './models'

const HEADER_RE = /^translate\s+(\S+)\s+([^:]+):$/

const NON_SAY_PREFIXES = [
  'voice', 'nvl', 'pass', 'if ', 'else', 'elif', '$', 'python', 'call', 'jump',
  // old/new 只属于 strings 块；混进对话块（如旧版把游戏自带 translate 块写进模板）时不按 say 解析
  'old ', 'new ',
]

// 复刻 fallback_parser 的正则：r?"..." | r?'...' | r?`...`
// 注意：必须带 g 标志，tokenize 依赖 lastIndex 做锚定搜索（等价 Python re.match(text[i:])）；
// 缺 g 时 lastIndex 被忽略、exec 总从 0 搜索，行内第二个字符串会触发 WORD 分支死循环。
const STRING_RE = /r?"([^\\"]|\\.)*"|r?'([^\\']|\\.)*'|r?`([^\\`]|\\.)*`/g

/** 解析 tl 文件中的字符串字面量（Python 语义的有限实现）。 */
export function parseStringLiteral(literal: string): string {
  const lit = literal.trim()
  if (lit.length >= 2) {
    const first = lit[0]
    const last = lit[lit.length - 1]
    if (first === last && (first === '"' || first === "'" || first === '`')) {
      // raw 前缀
      if (lit.startsWith('r') && lit.length >= 3) {
        return lit.slice(2, -1)
      }
      return unquoteUnicode(lit.slice(1, -1))
    }
  }
  return unquoteUnicode(lit)
}

/** 复刻 fallback_parser._tokenize：拆成 (类型, 文本) 令牌。 */
export function tokenize(text: string): Array<[string, string]> {
  const tokens: Array<[string, string]> = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    STRING_RE.lastIndex = i
    const m = STRING_RE.exec(text)
    if (m && m.index === i) {
      tokens.push(['STR', m[0]])
      i = m.index + m[0].length
      continue
    }
    if (c === '(' || c === ')' || c === '@') {
      tokens.push(['PUNCT', c])
      i += 1
      continue
    }
    const jStart = i
    let j = jStart
    while (j < text.length && !/\s/.test(text[j]!) && !'()@"\'`'.includes(text[j]!)) {
      j += 1
    }
    // 防御：本位置既非字符串起点也非空白/标点（如孤立不配对引号）时，
    // 必须至少推进一个字符，否则 i 不前进会死循环吞内存。
    if (j === i) {
      tokens.push(['WORD', text[i]!])
      i += 1
    } else {
      tokens.push(['WORD', text.slice(i, j)])
      i = j
    }
  }
  return tokens
}

/** 解析 tl 文件中的规范 say 行；失败返回 null。 */
export function parseSayLine(text: string, indent = ''): SayLine | null {
  const stripped = text.trim()
  if (!stripped) return null
  if (NON_SAY_PREFIXES.some((p) => stripped.startsWith(p))) return null
  const tokens = tokenize(stripped)
  if (tokens.length === 0) return null

  let who: string | null = null
  const attrs: string[] = []
  const temps: string[] = []
  let idx = 0

  if (tokens[0]![0] === 'STR') {
    if (tokens.length > 1 && tokens[1]![0] === 'STR') {
      // S17：字符串说话人（掩名，如 "..." / "???"）必须保留引号原样，
      // 否则 render 会输出裸标识符行 `... "译"`，Ren'Py 将其解析为省略号语句+裸串 → expected statement。
      who = tokens[0]![1]
      idx = 1
    }
  } else {
    who = tokens[0]![1]
    idx = 1
    let inTemp = false
    while (idx < tokens.length && tokens[idx]![0] !== 'STR') {
      const [kind, value] = tokens[idx]!
      if (kind === 'PUNCT') {
        // say 的 who/属性区只有词与 @；出现括号等标点说明是函数调用等表达式语句
        // （如死块里回读的 renpy.register_shader(...)），当 say 解析会产出非法说话人单元。
        if (value !== '@') return null
        inTemp = true
      } else {
        // say 行的 who/属性位不可能含 =；含 = 的是赋值行（gui.text_font = "..."），
        // 解析成 say 会产出非法说话人噪声单元（invalid_speakers / 待译队列污染）。
        if (kind === 'WORD' && value.includes('=')) return null
        ;(inTemp ? temps : attrs).push(value)
      }
      idx += 1
    }
  }

  if (idx >= tokens.length || tokens[idx]![0] !== 'STR') return null

  const what = decodeString(tokens[idx]![1])
  const prefixParts: string[] = []
  if (who !== null) prefixParts.push(who)
  prefixParts.push(...attrs)
  if (temps.length > 0) {
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
    raw: stripped,
    indent,
  })
}

/** 取块内最近一条 `# ` 注释的内容（复刻 _last_comment_line）。 */
function lastCommentLine(chunk: TlChunk): string {
  for (let i = chunk.bodyLines.length - 1; i >= 0; i -= 1) {
    const [, text] = chunk.bodyLines[i]!
    const stripped = text.trim()
    if (stripped.startsWith('# ')) return stripped.slice(2)
  }
  return ''
}

/** 从块内 `# file:line` 注释解析行号。 */
function chunkLineNumber(chunk: TlChunk): number {
  for (const [, text] of chunk.bodyLines) {
    const m = /:(\d+)\s*$/.exec(text.trim())
    if (m) return Number(m[1])
  }
  return 0
}

function makeChunk(kind: string, headerIndex: number, identifier: string | null): TlChunk {
  return {
    kind,
    raw: [],
    headerIndex,
    identifier,
    sayLines: [],
    originals: [],
    bodyLines: [],
    pairs: [],
  }
}

/** 解析单个 tl 文件为块列表。 */
export function parseTlFile(path: string, lang: string): TlChunk[] {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const chunks: TlChunk[] = []
  let current: TlChunk | null = null

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!
    const m = HEADER_RE.exec(line.trim())
    if (m && m[1] === lang) {
      if (current !== null) chunks.push(current)
      const identifier = m[2]!.trim()
      if (identifier === 'strings') {
        current = makeChunk('strings', idx, 'strings')
      } else if (identifier === 'python') {
        current = makeChunk('python', idx, 'python')
      } else if (identifier.startsWith('style ')) {
        current = makeChunk('style', idx, identifier)
      } else {
        current = makeChunk('dialogue', idx, identifier)
      }
      current.raw.push(line)
      continue
    }

    if (current === null) {
      if (chunks.length === 0) {
        chunks.push(makeChunk('raw', idx, null))
        chunks[chunks.length - 1]!.raw.push(line)
      } else if (line.trim()) {
        chunks.push(makeChunk('raw', idx, null))
        chunks[chunks.length - 1]!.raw.push(line)
      } else {
        chunks[chunks.length - 1]!.raw.push(line)
      }
      continue
    }

    current.raw.push(line)
    const stripped = line.trim()

    if (current.kind === 'strings') {
      const oldM = /^old\s+(.+)$/.exec(stripped)
      const newM = /^new\s+(.+)$/.exec(stripped)
      if (oldM) {
        current.pairs.push({
          oldIdx: idx,
          newIdx: -1,
          old: parseStringLiteral(oldM[1]!),
          new: '',
        })
      } else if (newM && current.pairs.length > 0 && current.pairs[current.pairs.length - 1]!.newIdx === -1) {
        const pair = current.pairs[current.pairs.length - 1]!
        pair.new = parseStringLiteral(newM[1]!)
        pair.newIdx = current.raw.length - 1
      }
    } else if (current.kind === 'dialogue') {
      if (stripped.startsWith('#') || !stripped) {
        current.bodyLines.push([idx, line, false])
      } else {
        const indent = line.slice(0, line.length - line.replace(/^\s*/, '').length)
        const say = parseSayLine(stripped, indent)
        if (say !== null) {
          const original = parseSayLine(lastCommentLine(current))
          if (original !== null) say.originalWhat = original.what
          current.originals.push(original)
          current.sayLines.push(say)
          current.bodyLines.push([idx, line, true])
        } else {
          current.bodyLines.push([idx, line, false])
        }
      }
    }
  }

  if (current !== null) chunks.push(current)
  return chunks
}

function resolveGameDir(gameDir: string): string {
  const g = join(gameDir, 'game')
  return existsSync(g) && statSync(g).isDirectory() ? g : gameDir
}

/** tl/<lang> 目录根（支持 game/ 子目录）。 */
export function tlRoot(gameDir: string, lang: string): string {
  return join(resolveGameDir(gameDir), 'tl', lang)
}

/** 递归收集 tl/<lang>/ 下的 .rpy 文件。 */
function collectRpyFiles(dir: string): string[] {
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectRpyFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.rpy')) {
      out.push(full)
    }
  }
  return out
}

/** 转换为 posix 相对路径。 */
function toPosixRel(file: string, root: string): string {
  return relative(root, file).split(sep).join('/')
}

/** 解析 tl/<lang>/ 下所有 .rpy 文件。 */
export function parseTlDirectory(gameDir: string, lang: string): Array<[string, TlChunk[]]> {
  const root = tlRoot(gameDir, lang)
  const result: Array<[string, TlChunk[]]> = []
  if (!existsSync(root)) return result
  const paths = collectRpyFiles(root).sort()
  for (const path of paths) {
    result.push([path, parseTlFile(path, lang)])
  }
  return result
}

/**
 * 加载 tl/<lang>：返回 (文件块, 对话单元, 字符串单元)。
 * 复刻 tlparser.load_work。
 */
export function loadWork(
  gameDir: string,
  lang: string,
): [Array<[string, TlChunk[]]>, DialogueUnit[], StringUnit[]] {
  const files = parseTlDirectory(gameDir, lang)
  const dialogue: DialogueUnit[] = []
  const strings: StringUnit[] = []
  const root = tlRoot(gameDir, lang)

  for (const [path, chunks] of files) {
    const rel = toPosixRel(path, root)
    for (const chunk of chunks) {
      if (chunk.kind === 'dialogue') {
        const line = chunkLineNumber(chunk)
        const unit = new DialogueUnit({
          identifier: chunk.identifier ?? '',
          filename: rel,
          linenumber: line,
          label: null,
          sayLines: chunk.sayLines,
          rawStatements: chunk.bodyLines
            .filter(([, text, isSay]) => !isSay && text.trim() !== '')
            .map(([, text]) => text),
        })
        chunk.sayLines.forEach((say, i) => {
          const original = chunk.originals[i]
          say.originalWhat = original?.what ?? null
        })
        dialogue.push(unit)
      } else if (chunk.kind === 'strings') {
        for (const pair of chunk.pairs) {
          strings.push(new StringUnit({
            old: pair.old,
            new: pair.new,
            filename: rel,
            linenumber: pair.oldIdx,
          }))
        }
      }
    }
  }
  return [files, dialogue, strings]
}

/**
 * 重建块内容。say_translations: say_lines 下标 -> 译文；string_translations: old -> 新译文。
 * 复刻 tlparser.rebuild_chunk。
 */
export function rebuildChunk(
  chunk: TlChunk,
  sayTranslations?: Map<number, string> | Record<number, string> | null,
  stringTranslations?: Map<string, string> | Record<string, string> | null,
): string[] {
  if (chunk.kind === 'raw' || chunk.kind === 'python' || chunk.kind === 'style') {
    return [...chunk.raw]
  }

  if (chunk.kind === 'dialogue') {
    const translations = new Map<number, string>()
    if (sayTranslations) {
      for (const [k, v] of entriesOf(sayTranslations)) translations.set(Number(k), String(v))
    }
    const out: string[] = chunk.raw.length > 0 ? [chunk.raw[0]!] : []
    let sayIndex = 0
    for (const [, text, isSay] of chunk.bodyLines) {
      if (!isSay) {
        out.push(text)
        continue
      }
      const original = chunk.sayLines[sayIndex]
      const newWhat = translations.get(sayIndex)
      if (original !== undefined && newWhat !== undefined) {
        out.push(original.render(newWhat))
      } else {
        out.push(text)
      }
      sayIndex += 1
    }
    return out
  }

  const out = [...chunk.raw]
  const stringMap = new Map<string, string>()
  if (stringTranslations) {
    for (const [k, v] of entriesOf(stringTranslations)) stringMap.set(String(k), String(v))
  }
  if (stringMap.size === 0) return out

  // 记录每个 old 是否已有 new
  const oldHasNew = new Map<number, boolean>()
  let lastOldIdx: number | null = null
  for (let idx = 0; idx < out.length; idx += 1) {
    const stripped = out[idx]!.trim()
    if (/^old\s+(.+)$/.test(stripped)) {
      lastOldIdx = idx
      oldHasNew.set(idx, false)
    } else if (/^new\s+(.+)$/.test(stripped) && lastOldIdx !== null) {
      oldHasNew.set(lastOldIdx, true)
    }
  }

  const result: string[] = []
  let currentOld: string | null = null
  for (let idx = 0; idx < out.length; idx += 1) {
    const line = out[idx]!
    const stripped = line.trim()
    const oldM = /^old\s+(.+)$/.exec(stripped)
    const newM = /^new\s+(.+)$/.exec(stripped)
    if (oldM) {
      currentOld = parseStringLiteral(oldM[1]!)
      result.push(line)
      if (!oldHasNew.get(idx)) {
        const translation = stringMap.get(currentOld)
        if (translation !== undefined) {
          const tagged = ensureTranslationTag(currentOld, translation)
          const indent = line.slice(0, line.length - line.replace(/^\s*/, '').length)
          result.push(`${indent}new "${quoteUnicode(tagged)}"`)
        }
      }
    } else if (newM && currentOld !== null) {
      const translation = stringMap.get(currentOld)
      if (translation !== undefined) {
        const tagged = ensureTranslationTag(currentOld, translation)
        const indent = line.slice(0, line.length - line.replace(/^\s*/, '').length)
        result.push(`${indent}new "${quoteUnicode(tagged)}"`)
      } else {
        result.push(line)
      }
    } else {
      result.push(line)
    }
  }
  return result
}

/** 把已翻译的块还原为模板态。 */
export function restoreChunk(chunk: TlChunk): string[] {
  if (chunk.kind === 'raw' || chunk.kind === 'python' || chunk.kind === 'style') {
    return [...chunk.raw]
  }

  if (chunk.kind === 'dialogue') {
    const out: string[] = chunk.raw.length > 0 ? [chunk.raw[0]!] : []
    let sayIndex = 0
    for (const [, text, isSay] of chunk.bodyLines) {
      if (!isSay) {
        out.push(text)
        continue
      }
      const say = sayIndex < chunk.sayLines.length ? chunk.sayLines[sayIndex] : undefined
      if (say !== undefined && say.originalWhat !== null) {
        out.push(say.render(say.originalWhat))
      } else {
        out.push(text)
      }
      sayIndex += 1
    }
    return out
  }

  const remove = new Set(chunk.pairs.filter((p) => p.newIdx >= 0).map((p) => p.newIdx))
  return chunk.raw.filter((_, i) => !remove.has(i))
}

/** 通用：把 Map 或 Record 展平成 [key, value] 迭代。 */
function entriesOf<T>(input: Map<number | string, T> | Record<number | string, T>): Array<[string, T]> {
  if (input instanceof Map) return [...input.entries()].map(([k, v]) => [String(k), v] as [string, T])
  return Object.entries(input)
}
