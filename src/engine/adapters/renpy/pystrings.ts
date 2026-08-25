/**
 * Python 字符串字面量求值（移植 ast.literal_eval 对字符串字面量的语义，
 * 供 scanFallbackStrings 解析 _()/_p() 包裹的字符串）。
 *
 * 支持：相邻字面量拼接、u/r/ur 前缀、单/双引号、三引号、常见转义
 * （\\ ' " \n \t \r \b \f \a \v \xHH \uHHHH \UHHHHHHHH \NNN 八进制、未知转义保留字符）。
 * 遇到非字符串表达式（逗号/tuple、未知结构）时返回 null（fail-closed）。
 */

export interface LiteralToken {
  value: string
  rest: string
}

const PY_PREFIX_RE = /^[rRuU]{0,2}/

/** 求值 Python 字符串字面量表达式；无法解析时返回 null。 */
export function parsePythonStringLiteral(expr: string): string | null {
  let s = expr.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim()
  }
  if (s.length === 0 || s.includes(',')) return null
  let result = ''
  let rest = s
  while (rest.length > 0) {
    rest = rest.trimStart()
    if (rest.length === 0) break
    const tok = parseOneLiteral(rest)
    if (tok === null) return null
    result += tok.value
    rest = tok.rest
  }
  return result
}

/** 解析一个字符串字面量（含前缀），返回解码值与剩余文本。 */
function parseOneLiteral(s: string): LiteralToken | null {
  const prefix = PY_PREFIX_RE.exec(s)![0]
  const i0 = prefix.length
  const quote = s[i0]
  if (quote !== '"' && quote !== "'") return null
  const raw = prefix.includes('r') || prefix.includes('R')
  const isTriple = s.slice(i0, i0 + 3) === quote.repeat(3)

  let i = i0 + (isTriple ? 3 : 1)
  let value = ''
  let closed = false
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\' && !raw) {
      const next = s[i + 1]
      if (next === undefined) return null
      let consumed = 2
      switch (next) {
        case 'n': value += '\n'; break
        case 't': value += '\t'; break
        case 'r': value += '\r'; break
        case 'b': value += '\b'; break
        case 'f': value += '\f'; break
        case 'a': value += '\x07'; break
        case 'v': value += '\x0b'; break
        case '\\': value += '\\'; break
        case "'": value += "'"; break
        case '"': value += '"'; break
        case 'x': {
          const hex = s.slice(i + 2, i + 4)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
          value += String.fromCharCode(parseInt(hex, 16))
          consumed = 4
          break
        }
        case 'u': {
          const hex = s.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
          value += String.fromCodePoint(parseInt(hex, 16))
          consumed = 6
          break
        }
        case 'U': {
          const hex = s.slice(i + 2, i + 10)
          if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null
          value += String.fromCodePoint(parseInt(hex, 16))
          consumed = 10
          break
        }
        default: {
          if (next >= '0' && next <= '7') {
            let oct = next
            let j = i + 2
            while (j < s.length && j < i + 4) {
              const ch = s[j]
              if (ch === undefined || ch < '0' || ch > '7') break
              oct += ch
              j += 1
            }
            value += String.fromCharCode(parseInt(oct, 8))
            consumed = j - i
          } else {
            value += next // Python：未知转义保留原字符
          }
        }
      }
      i += consumed
      continue
    }
    if (isTriple) {
      if (c === quote && s.slice(i, i + 3) === quote.repeat(3)) {
        i += 3
        closed = true
        break
      }
      value += c
      i += 1
      continue
    }
    if (c === quote) {
      i += 1
      closed = true
      break
    }
    if (c === '\n') return null // 单行字符串不允许裸换行
    value += c
    i += 1
  }
  if (!closed) return null
  return { value, rest: s.slice(i) }
}
