/**
 * 扫描散落在 tl/ 之外的 .rpy 用户可见文字。
 * 这是 tl 模板的补充信号：编译版通常没有 .rpy，源码项目里可用来发现漏提文本。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { decodeString } from './compat'

export interface ScatteredText {
  file: string
  line: number
  type: 'say' | 'menu' | 'translatable'
  text: string
  raw: string
}

const STRING_RE = /r?"([^\\"]|\.)*"|r?'([^\']|\.)*'|r?`([^\`]|\.)*`/g

/** 复刻 fallback_parser._classify 的关键字集合。 */
const PLAIN_KEYWORDS = new Set([
  'show', 'show layer', 'camera', 'hide', 'scene', 'with', 'play', 'stop',
  'queue', 'window', 'call', 'jump', 'return', 'pass', 'voice', 'nvl clear',
])
const BLOCK_SKIP_KEYWORDS = new Set([
  'python', 'while', 'for', 'screen', 'transform', 'image', 'style',
  'layeredimage', 'default', 'define',
])

function classifySay(text: string): boolean {
  const stripped = text.trim()
  if (!stripped) return false
  const words = stripped.split(/\s+/)
  const first = (words[0] ?? '').replace(/:$/, '')
  const two = words.slice(0, 2).map((w) => w.replace(/:$/, '')).join(' ')
  if (first === '$') return false
  if (PLAIN_KEYWORDS.has(first) || PLAIN_KEYWORDS.has(two)) return false
  if (BLOCK_SKIP_KEYWORDS.has(first) || BLOCK_SKIP_KEYWORDS.has(two)) return false
  if (first === 'menu' || first === 'label' || first === 'if' || first === 'elif' || first === 'else') return false
  return true
}

function findSayString(line: string): { text: string; raw: string } | null {
  if (!classifySay(line)) return null
  STRING_RE.lastIndex = 0
  // 跳过语句开头直到第一个字符串
  let m = STRING_RE.exec(line)
  if (!m) return null
  const firstToken = line.trimStart().slice(0, m.index).trim()
  if (firstToken === '' || firstToken === '(' || firstToken === '_(' || firstToken.startsWith('_(')) return null
  const literal = m[0]
  m = STRING_RE.exec(line)
  // say 语句允许 "who" "what" 两个字符串；菜单选项本身是单字符串+冒号
  if (m && line.trimEnd().endsWith(':')) return null
  return { text: decodeString(literal), raw: literal }
}

/** 扫描 gameDir 下非 tl 的 .rpy/.rpym，返回可见文本清单。 */
export function scanScatteredRpy(gameRoot: string, lang = 'chinese'): ScatteredText[] {
  void lang
  const root = join(gameRoot, 'game')
  const base = existsSync(root) && statSync(root).isDirectory() ? root : gameRoot
  const files = collectRpy(base)
  const out: ScatteredText[] = []

  for (const path of files) {
    const text = readFileSync(path, 'utf8').replace(/\ufeff/g, '')
    const lines = text.split('\n')
    const rel = relative(base, path).split(sep).join('/')
    let inMenu = false
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!
      const line = raw.trim()
      if (!line) continue

      // menu 块内的选项行："Choice" if cond: 或 "Choice":
      const indented = raw.startsWith(' ') || raw.startsWith('\t')
      if (/^menu(?:\s|:)/.test(line)) {
        inMenu = true
        continue
      }
      if (inMenu && indented) {
        if (!line.endsWith(':') && !/^\w/.test(line)) inMenu = false
        const choice = parseChoice(line)
        if (choice) {
          out.push({ file: rel, line: i + 1, type: 'menu', text: choice.text, raw: choice.raw })
          continue
        }
      }

      const translatable = parseTranslatable(line)
      if (translatable) {
        out.push({ file: rel, line: i + 1, type: 'translatable', text: translatable.text, raw: translatable.raw })
        continue
      }

      const say = findSayString(line)
      if (say) {
        out.push({ file: rel, line: i + 1, type: 'say', text: say.text, raw: say.raw })
      }
    }
  }
  return out
}

function parseChoice(line: string): { text: string; raw: string } | null {
  STRING_RE.lastIndex = 0
  const m = STRING_RE.exec(line)
  if (!m) return null
  if (!/^[ \t]*r?["'`]/.test(line)) return null
  return { text: decodeString(m[0]), raw: m[0] }
}

function parseTranslatable(line: string): { text: string; raw: string } | null {
  const pattern = /\b_{1,2}\(\s*(r?"([^\\"]|\.)*"|r?'([^\']|\.)*'|r?`([^\`]|\.)*`)/
  const m = pattern.exec(line)
  if (!m) return null
  return { text: decodeString(m[1]!), raw: m[1]! }
}

function collectRpy(dir: string): string[] {
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'tl') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRpy(full))
    else if (entry.isFile() && (entry.name.endsWith('.rpy') || entry.name.endsWith('.rpym'))) out.push(full)
  }
  return out.sort()
}
