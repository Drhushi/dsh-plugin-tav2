/**
 * 复刻 Ren'Py 的字符串解码/编码规则（renpy/lexer.py string() 与 translation.encode_say_string）。
 * 移植自 tav2 的 adapters/renpy/renpy_compat.py。
 */

export const TEMP_TAG_RE = /\{\#[^{}\n]*\}/g

export const STRING_PATTERN = /r?"([^\\"]|\\.)*"|r?'([^\\']|\\.)*'|r?`([^\\`]|\\.)*`/g

/** 在语句文本中找第一个 Ren'Py 字符串字面量，返回 (literal, start, end)。 */
export function findStringLiteral(text: string): {
  literal: string
  start: number
  end: number
} | null {
  STRING_PATTERN.lastIndex = 0
  const m = STRING_PATTERN.exec(text)
  if (!m) return null
  return { literal: m[0], start: m.index, end: m.index + m[0].length }
}

/** 字符串翻译标签保真：old 含 {#tag} 而译文未携带时，把标签补到译文头部。 */
export function ensureTranslationTag(old: string, translation: string): string {
  if (!translation) return translation
  const tags = old.match(TEMP_TAG_RE) ?? []
  if (tags.length === 0 || TEMP_TAG_RE.test(translation)) return translation
  return tags.join('') + translation
}

/** 把 Ren'Py 字符串字面量解码为实际字符串（含转义与空白折叠）。 */
export function decodeString(literal: string): string {
  let raw = false
  let lit = literal
  if (lit.startsWith('r')) {
    raw = true
    lit = lit.slice(1)
  }

  const body = lit.slice(1, -1)
  if (raw) return body

  const collapsed = body.replace(/[ \n]+/g, ' ')

  let result = ''
  let i = 0
  while (i < collapsed.length) {
    const c = collapsed[i]!
    if (c === '\\') {
      const next = collapsed[i + 1]
      if (next === undefined) {
        // 末尾单独反斜杠，原样保留
        result += c
        i += 1
        continue
      }
      if (next === '{') {
        result += '{{'
      } else if (next === '[') {
        result += '[['
      } else if (next === '%') {
        result += '%%'
      } else if (next === 'n') {
        result += '\n'
      } else if (next === 'u') {
        // 读取 1-4 位十六进制
        let digits = ''
        let j = i + 2
        while (j < collapsed.length && digits.length < 4 && /[0-9a-fA-F]/.test(collapsed[j]!)) {
          digits += collapsed[j]
          j += 1
        }
        if (digits.length > 0) {
          result += String.fromCodePoint(parseInt(digits, 16))
        } else {
          // \u 后面没有十六进制，退化为原样
          result += next
        }
        i = j
        continue
      } else {
        result += next
      }
      i += 2
      continue
    }
    result += c
    i += 1
  }
  return result
}

/** 复刻 renpy.translation.encode_say_string。 */
export function encodeSayString(s: string): string {
  let out = s.replace(/\\/g, '\\\\')
  out = out.replace(/\n/g, '\\n')
  out = out.replace(/"/g, '\\"')
  // 把“两个连续空格”中的第二个空格转义为 \ （保留空白折叠语义）
  out = out.replace(/(?<= ) /g, '\\ ')
  return '"' + out + '"'
}

/** 复刻 renpy.translation.quote_unicode（字符串块 old/new 的写盘转义）。 */
export function quoteUnicode(s: string): string {
  let out = s.replace(/\\/g, '\\\\')
  out = out.replace(/"/g, '\\"')
  out = out.replace(/\u0007/g, '\\a')
  out = out.replace(/\u0008/g, '\\b')
  out = out.replace(/\u000c/g, '\\f')
  out = out.replace(/\n/g, '\\n')
  out = out.replace(/\r/g, '\\r')
  out = out.replace(/\t/g, '\\t')
  out = out.replace(/\u000b/g, '\\v')
  return out
}

const UNQUOTE_MAP: Record<string, string> = {
  a: '\u0007',
  b: '\u0008',
  f: '\u000c',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\u000b',
  '\\': '\\',
  '"': '"',
}

/** quote_unicode 的逆操作（Python 字符串字面量语义）。 */
export function unquoteUnicode(s: string): string {
  let result = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      const next = s[i + 1]
      if (next !== undefined) {
        result += UNQUOTE_MAP[next] ?? next
        i += 2
        continue
      }
    }
    result += c
    i += 1
  }
  return result
}
