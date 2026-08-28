/**
 * 译前快筛（与 Python tav2/scanning.py 对齐）：
 * 本地正则提取专名/术语/全大写候选 + 目标语言护栏 + 上下文样本。
 */

import type { EngineConfig } from './config'

export const SOURCE_LANGUAGE_GUARD_THRESHOLD = 0.2

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g
const KANA_RE = /[\u3040-\u30ff]/g
const LOC_RE = /^\[([^\]]+):(\d+)\]\s?(.*)$/
const WORD_RE = /[A-Za-z][A-Za-z0-9'_-]*/g
const ALLCAPS_RE = /\b[A-Z]{2,}(?:[-–][A-Z0-9]+)*\b/g
const ALLCAPS_FULL_RE = /^[A-Z]{2,}(?:[-–][A-Z0-9]+)*$/

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we',
  'they', 'my', 'your', 'his', 'her', 'our', 'their', 'me', 'him', 'us', 'them',
  'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'when', 'what', 'who', 'how',
  'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  'have', 'has', 'had', 'do', 'does', 'did', 'just', 'like', 'well', 'okay',
  'oh', 'ah', 'um', 'uh', 'hey', 'hello', 'hi', 'thanks', 'thank', 'please',
  'really', 'very', 'much', 'many', 'some', 'any', 'all', 'one', 'two', 'three',
  'man', 'woman', 'guy', 'girl', 'boy', 'thing', 'things', 'something', 'nothing',
  'right', 'ok', 'yeah', 'yep', 'nope', 'sure', 'fine', 'good', 'bad', 'big',
  'small', 'know', 'think', 'see', 'look', 'want', 'need', 'get', 'go', 'come',
  'make', 'take', 'say', 'said', 'tell', 'told', 'ask', 'asked', 'back', 'still',
  'even', 'maybe', 'always', 'never', 'also', 'here', 'there', 'now', 'then',
])

/** 额外默认停用词（报告噪音实测：time/more/less/day 等通用词高频入选）。 */
const EXTRA_STOPWORDS = new Set([
  'time', 'times', 'more', 'less', 'day', 'days', 'week', 'weeks', 'month',
  'months', 'year', 'years', 'minute', 'minutes', 'hour', 'hours', 'moment',
  'moments', 'today', 'tonight', 'tomorrow', 'yesterday', 'people', 'someone',
  'everyone', 'anyone', 'everything', 'little', 'lot', 'lots', 'stuff', 'gonna',
  'wanna', 'kinda', 'sorta', 'hmm', 'huh', 'mmm', 'ugh', 'phew',
])

/** 拟声/感叹/语气词（句首大写会混过专名正则，如 Hehe/Hiccup；世界书与术语都不收）。 */
const INTERJECTION_STOPWORDS = new Set([
  'hehe', 'hehehe', 'haha', 'hahaha', 'hah', 'mm', 'mmm', 'ooh', 'aah', 'ahh',
  'whoa', 'oops', 'whoops', 'yay', 'yikes', 'eww', 'gulp', 'sigh', 'sighs',
  'sob', 'sobs', 'hiccup', 'hiccups', 'whimper', 'whimpers', 'giggle',
  'giggles', 'chuckle', 'chuckles', 'gasp', 'gasps', 'moan', 'moans',
])

const ALL_STOPWORDS = new Set([...STOPWORDS, ...EXTRA_STOPWORDS, ...INTERJECTION_STOPWORDS])

export interface ScanCandidate {
  source: string
  kind: 'name' | 'allcaps'
  frequency: number
  /** 出现过的原文行号（升序去重；供术语驱动世界书按名字收集上下文）。 */
  positions: number[]
  samples: string[]
}

/** 目标语言字符数（chinese 按 CJK 计；其余语言按同一套 CJK 兜底）。 */
export function targetChars(text: string): number {
  return (text.match(CJK_RE) ?? []).length + (text.match(KANA_RE) ?? []).length
}

function stripLoc(line: string): string {
  const m = LOC_RE.exec(line.trim())
  return m?.[3] ?? line.trim()
}

function loc(line: string): string {
  const m = LOC_RE.exec(line.trim())
  return m ? `${m[1]}:${m[2]}` : ''
}

/** 目标语言字符占比（chinese 按 CJK 计；其余语言按同一套 CJK 兜底）。 */
export function targetLanguageRatio(lines: string[], lang: string): number {
  void lang
  let totalChars = 0
  let target = 0
  for (const line of lines) {
    const body = stripLoc(line)
    totalChars += body.length
    target += targetChars(body)
  }
  if (totalChars === 0) return 0
  return target / totalChars
}

/** 语言护栏：目标语言字符占比超过阈值时中止。 */
export function checkSourceLanguage(lines: string[], lang: string): void {
  const ratio = targetLanguageRatio(lines, lang)
  if (ratio > SOURCE_LANGUAGE_GUARD_THRESHOLD) {
    const pct = (ratio * 100).toFixed(0)
    throw new Error(
      `输入疑似读到了 tl 译文：目标语言字符占比 ${pct}% 超过阈值 20%。请确认输入为原版源文本。`,
    )
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 找 source 在原文行（去 loc 前缀后）的所有行号：拉丁词按词边界、其他按子串。
 * 供人名代码种子等「非快扫候选」复用出现位置。
 */
export function findOccurrences(lines: string[], source: string): number[] {
  const positions: number[] = []
  if (!source) return positions
  const isLatin = /[A-Za-z]/.test(source)
  const re = isLatin
    ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(source)}(?![A-Za-z0-9_])`, 'i')
    : null
  for (let i = 0; i < lines.length; i += 1) {
    const body = stripLoc(lines[i]!)
    if (re ? re.test(body) : body.includes(source)) positions.push(i)
  }
  return positions
}

function collectWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(WORD_RE)) {
    // 词法修复：WORD_RE 允许词中连字符，但断词换行会把「fembo-」这类截断残片整词捕获，
    // 剥掉词尾连字符/撇号/下划线再收。
    const token = m[0].replace(/['_-]+$/, '')
    if (token) out.push(token)
  }
  return out
}

/** 提取专名候选：首字母大写的词/词组、全大写词。 */
export function _nameCandidates(text: string, stopwords: Set<string> = ALL_STOPWORDS): string[] {
  const out: string[] = []
  const words = collectWords(text)
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (ALLCAPS_FULL_RE.test(w) && w.length >= 2) {
      out.push(w)
      i += 1
      continue
    }
    if (w.slice(0, 1).toUpperCase() === w.slice(0, 1) && !stopwords.has(w.toLowerCase())) {
      const seq = [w]
      let j = i + 1
      while (j < words.length && words[j]!.slice(0, 1).toUpperCase() === words[j]!.slice(0, 1)) {
        seq.push(words[j]!)
        j += 1
      }
      const joined = seq.join(' ')
      if (seq.length === 1 && seq[0]!.length < 3) {
        i = j
        continue
      }
      if (seq.length === 1) {
        out.push(seq[0]!)
      } else {
        out.push(joined)
        out.push(seq[0]!)
      }
      i = j
      continue
    }
    i += 1
  }
  return out
}

/** 扫描原文行，返回候选列表 [{source, kind, frequency, samples}]。 */
export function scanLines(lines: string[], cfg: EngineConfig): ScanCandidate[] {
  const minFrequency = cfg.scan.minFrequency
  const maxItems = cfg.scan.maxItems
  const window = cfg.scan.contextWindowLines
  const maxSamples = cfg.scan.maxContextSamples
  const stopwords = new Set([...ALL_STOPWORDS, ...cfg.scan.stopwords])

  if (cfg.scan.sourceLanguageGuard) checkSourceLanguage(lines, cfg.lang)

  // 方案 A：专名白名单（游戏特有小写设定词）→ 小写 → 规范形式，用于命中与去重折叠。
  const whitelist = new Map<string, string>()
  for (const w of cfg.scan.extraProperNouns ?? []) {
    const t = w.trim()
    if (!t) continue
    whitelist.set(t.toLowerCase(), t)
  }

  const counts = new Map<string, number[]>()
  const add = (candidate: string, kind: string, index: number): void => {
    const key = `${kind}\u0000${candidate}`
    const list = counts.get(key) ?? []
    list.push(index)
    counts.set(key, list)
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const body = stripLoc(lines[idx]!)
    for (const cand of _nameCandidates(body, stopwords)) add(cand, 'name', idx)
    for (const m of body.matchAll(ALLCAPS_RE)) add(m[0], 'allcaps', idx)
    for (const [low, canonical] of whitelist) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(canonical)}(?![A-Za-z0-9_])`, 'i')
      if (re.test(body)) add(canonical, 'name', idx)
    }
  }

  // 折叠：命中白名单的 name 候选（如大写 “Mood”）并入白名单规范形式（“mood”）。
  if (whitelist.size > 0) {
    const merge: Array<[string, string]> = []
    for (const key of counts.keys()) {
      const sep = key.indexOf('\u0000')
      if (key.slice(0, sep) !== 'name') continue
      const source = key.slice(sep + 1)
      const canonical = whitelist.get(source.toLowerCase())
      if (canonical && canonical !== source) merge.push([key, `name\u0000${canonical}`])
    }
    for (const [fromKey, toKey] of merge) {
      const from = counts.get(fromKey) ?? []
      counts.delete(fromKey)
      const to = counts.get(toKey) ?? []
      counts.set(toKey, [...to, ...from])
    }
  }

  const candidates: ScanCandidate[] = []
  const threshold = Math.max(2, Math.floor(minFrequency / 2))
  for (const [key, indexes] of counts) {
    const sep = key.indexOf('\u0000')
    const kind = key.slice(0, sep) as ScanCandidate['kind']
    const source = key.slice(sep + 1)
    const frequency = indexes.length
    if (frequency < threshold) continue
    const samples: string[] = []
    for (const pos of indexes.slice(0, maxSamples * 2)) {
      const start = Math.max(0, pos - window)
      const end = Math.min(lines.length, pos + window + 1)
      const snippet = lines.slice(start, end).map(stripLoc).join(' | ')
      if (!samples.includes(snippet)) samples.push(snippet)
      if (samples.length >= maxSamples) break
    }
    candidates.push({
      source,
      kind,
      frequency,
      positions: [...new Set(indexes)].sort((a, b) => a - b),
      samples,
    })
  }

  candidates.sort((a, b) => b.frequency - a.frequency || a.source.localeCompare(b.source))
  return candidates.slice(0, maxItems)
}
