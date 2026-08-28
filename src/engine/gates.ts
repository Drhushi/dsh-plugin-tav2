/**
 * 质量门禁：标签保持、术语审计、反翻译腔、一致性审计。
 * 从 tav2/gates.py 移植；另含 ensure_translation_tag（tav2/renpy_compat）。
 */

const BRACE_TAG_RE = /\{[^{}\n]*\}/g
const BRACKET_TAG_RE = /\[[^\]\n]+\]/g
const TEMP_TAG_RE = /\{\#[^{}\n]*\}/g
/** 匹配「一段连续反斜杠 + n」，按连跑长度分类计数（区分字面 \n 与双重转义 \\n）。 */
const ESC_N_RE = /(\\+)n/g

/**
 * Ren'Py 符号清单（in-memory 表示）。tl 文件里的 \n 转义经 decodeString 读入后就是真实换行符，
 * 写盘时由 encodeSayString / quoteUnicode 转回 \n——所以「真实换行」就是 \n 转义的载体；
 * 而字面反斜杠+n（连跑长度 1）对应文件里的双重转义 \\n，会原样显示成文字。
 */
export interface RenpySymbolCounts {
  /** {...} 文本标签与 [...] 插值，逐 token 计数（multiset）。 */
  tags: Map<string, number>
  /** 真实换行符个数（= Ren'Py \n 转义个数）。 */
  newlines: number
  pct: number
  braceL: number
  braceR: number
  /** 反斜杠连跑长度 -> 后跟 n 的出现次数（长度 1 = 文件里的 \\n，显示为文字 \n）。 */
  escRuns: Map<number, number>
  /** 字面 /n 序列数（含 //n；不是合法 Ren'Py 转义，出现即模型损坏）。 */
  slashN: number
}

function countSeq(text: string, seq: string): number {
  return text.split(seq).length - 1
}

/** 提取 Ren'Py 标签/插值（逐 token 计数）与换行、%%、{{、}}、双重转义、斜杠变体的逐类计数。 */
export function renpyTokens(text: string): RenpySymbolCounts {
  const tags = new Map<string, number>()
  for (const m of text.matchAll(BRACE_TAG_RE)) tags.set(m[0], (tags.get(m[0]) ?? 0) + 1)
  for (const m of text.matchAll(BRACKET_TAG_RE)) tags.set(m[0], (tags.get(m[0]) ?? 0) + 1)
  const escRuns = new Map<number, number>()
  for (const m of text.matchAll(ESC_N_RE)) {
    const len = m[1]!.length
    escRuns.set(len, (escRuns.get(len) ?? 0) + 1)
  }
  return {
    tags,
    newlines: countSeq(text, '\n'),
    pct: countSeq(text, '%%'),
    braceL: countSeq(text, '{{'),
    braceR: countSeq(text, '}}'),
    escRuns,
    slashN: countSeq(text, '/n'),
  }
}

/**
 * 校验译文是否原样保留源文本中的 Ren'Py 标签、插值与转义（in-memory 表示见 renpyTokens）。
 * - 标签/插值逐 token 计数、换行与 %%/{{/}} 转义逐类计数：译文只能多不能少；
 * - 字面反斜杠+n（双重转义）按连跑长度逐一数量一致——它会原样显示成文字，多写少写都是显示损坏；
 * - 硬拒斜杠变体：译文出现源文没有的 /n、//n 即无效（真实事故：换行 \n 被整批翻成 //n）；
 * - {#tag} 是确定性可恢复的临时标签，不强制 LLM 携带（回填时自动补回）。
 */
export function tagsPreserved(source: string, translation: string): boolean {
  const src = renpyTokens(source)
  const dst = renpyTokens(translation)
  if (dst.slashN > src.slashN) return false
  const runLengths = new Set([...src.escRuns.keys(), ...dst.escRuns.keys()])
  for (const len of runLengths) {
    if ((src.escRuns.get(len) ?? 0) !== (dst.escRuns.get(len) ?? 0)) return false
  }
  if (
    src.tags.size === 0 && src.newlines === 0 && src.pct === 0
    && src.braceL === 0 && src.braceR === 0
  ) return true
  for (const [tag, n] of src.tags) {
    if (tag.startsWith('{#')) continue
    if ((dst.tags.get(tag) ?? 0) < n) return false
  }
  return dst.newlines >= src.newlines && dst.pct >= src.pct
    && dst.braceL >= src.braceL && dst.braceR >= src.braceR
}

/** 反翻译腔禁词（无原文对应时禁止出现；原文确有对应则允许）。 */
export const ANTI_TRANSLATIONESE = [
  '然而', '仿佛', '一丝', '不禁', '不禁令', '不由得', '似乎', '这般',
  '那般', '说道', '如此这般', '只见', '顿时', '刹那间', '旋即',
]

/** 返回译文命中的反翻译腔禁词（供报告，不阻塞）。 */
export function bannedWordHits(text: string): string[] {
  return ANTI_TRANSLATIONESE.filter((w) => text.includes(w))
}

// ---------- P1：反翻译腔禁令族（分类 + 确定性后过滤） ----------

/** 一个触发词：译文命中且源文无对应词时判为「无原文依据」。 */
export interface AntiClicheTrigger {
  /** 译文里的中文触发词。 */
  word: string
  /** 源文里允许它出现的对应词（存在任一即视为「有原文依据」，不命中）。 */
  sourceWords?: string[]
}

export interface AntiClicheCategory {
  id: string
  label: string
  rationale: string
  triggers: AntiClicheTrigger[]
  suggestions: string
}

/** 禁令族初始分类（自有措辞；全部遵循「源文无对应内容时禁止」）。 */
export const ANTI_CLICHE_CATEGORIES: AntiClicheCategory[] = [
  {
    id: 'transition',
    label: '转折腔',
    rationale: '无原文依据的「反而/反倒」式转折会改写句子逻辑，属信息污染。',
    triggers: [
      { word: '反而', sourceWords: ['but', 'however', 'yet', 'instead', 'on the contrary', 'rather'] },
      { word: '反倒', sourceWords: ['but', 'however', 'instead', 'on the contrary'] },
    ],
    suggestions: '若原文无 but/however 等转折词，直接删除该词；确有对应则保留。',
  },
  {
    id: 'intensifier',
    label: '程度堆砌',
    rationale: '无原文依据的「极其/格外/难以言喻」等程度修饰会放大情绪，超出原文语气。',
    triggers: [
      { word: '极其', sourceWords: ['extremely', 'utterly', 'exceedingly', 'absolutely'] },
      { word: '格外', sourceWords: ['especially', 'particularly', 'unusually'] },
      { word: '难以言喻', sourceWords: ['indescribable', 'unspeakable', 'inexpressible'] },
    ],
    suggestions: '原文没有对应程度副词时删除；保留原文语气强度，不自行加码。',
  },
  {
    id: 'physiological',
    label: '生理化套话',
    rationale: '无原文依据的「心口一紧/指节泛白/呼吸一滞」等是创作向套话，翻译不应自行添加。',
    triggers: [
      { word: '心口一紧' },
      { word: '指节泛白' },
      { word: '呼吸一滞' },
      { word: '呼吸急促', sourceWords: ['breathless', 'gasping', 'out of breath'] },
    ],
    suggestions: '无对应描写时删除；若原文确有生理反应描写，按其字面翻译，不用套话。',
  },
  {
    id: 'filler',
    label: '连接词填充',
    rationale: '无原文依据的「然而/仿佛/不禁/旋即」等连接与填充词是机翻腔高发词。',
    triggers: [
      { word: '然而', sourceWords: ['however', 'but', 'yet', 'nevertheless'] },
      { word: '仿佛', sourceWords: ['as if', 'as though', 'seem', 'like', 'as if to'] },
      { word: '一丝', sourceWords: ['a hint of', 'a trace of', 'a touch of', 'a sliver of'] },
      { word: '不禁', sourceWords: ['cannot help', "can't help", "couldn't help", 'couldnt help', 'could not help', 'cannot but'] },
      { word: '不由得' },
      { word: '旋即', sourceWords: ['immediately', 'at once', 'instantly', 'right away'] },
    ],
    suggestions: '原文无对应连接/修饰时删除；保留原句节奏，不用填充词补顺。',
  },
  {
    id: 'explanatory',
    label: '解释性补足',
    rationale: '无原文依据的「这意味着/也就是说」等追加说明会加戏，超出源文信息。',
    triggers: [
      { word: '这意味着', sourceWords: ['this means', 'which means', 'that means'] },
      { word: '也就是说', sourceWords: ['that is', 'i.e.', 'in other words', 'namely'] },
    ],
    suggestions: '原文没有解释性引导语时删除；不替读者加解读。',
  },
]

function sourceHasAny(source: string, words: string[] | undefined): boolean {
  if (!words || words.length === 0) return false
  const s = source.toLowerCase().replace(/['’]/g, '')
  return words.some((w) => s.includes(w.toLowerCase().replace(/['’]/g, '')))
}

export interface ApplyAntiClicheOptions {
  /** 只检查的分类 id；空=全部分类。 */
  categories?: string[]
  /** true=确定性移除填充词；false=仅报告命中（不改译文）。 */
  autoFix?: boolean
}

/**
 * 反翻译腔确定性后过滤（P1）：
 * 仅当源文无对应词时，对命中的触发词做报告（autoFix=true 时移除）。
 * 标签/插值/转义不触碰（触发词只匹配普通文本，标签集合与转义计数不变）。
 * 返回 { text, applied }；autoFix=false 时 text 恒等于入参译文。
 */
export function applyAntiCliche(
  source: string,
  translation: string,
  opts: ApplyAntiClicheOptions = {},
): { text: string; applied: Array<{ category: string; word: string }> } {
  const wanted = opts.categories && opts.categories.length > 0 ? opts.categories : undefined
  const enabled = ANTI_CLICHE_CATEGORIES.filter(
    (c) => !wanted || wanted.includes(c.id),
  )
  const applied: Array<{ category: string; word: string }> = []
  let text = translation
  for (const category of enabled) {
    for (const trigger of category.triggers) {
      if (!text.includes(trigger.word)) continue
      if (sourceHasAny(source, trigger.sourceWords)) continue
      applied.push({ category: category.id, word: trigger.word })
      if (opts.autoFix) {
        text = text.split(trigger.word).join('')
      }
    }
  }
  const fixed = opts.autoFix
    // 只折叠空格/制表符，保留换行（换行是 Ren'Py \n 转义的载体，折叠即显示损坏）
    ? text.replace(/[^\S\n]+/g, ' ').replace(/([，,、])\s*$/, '').trim()
    : translation
  return { text: fixed, applied }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 术语审计：源文本命中锁定术语时，译文必须包含其译名。返回漏用清单。 */
export function termAudit(
  translations: Record<string, string>,
  sources: Record<string, string>,
  lockedTerms: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const misses: Array<Record<string, string>> = []
  for (const term of lockedTerms) {
    const source = String(term.source ?? '').trim()
    const target = String(term.target ?? '').trim()
    if (source.length < 2 || !target) continue
    const pattern = /[A-Za-z]/.test(source)
      ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(source)}(?![A-Za-z0-9_])`)
      : null
    for (const [unitId, translation] of Object.entries(translations)) {
      const srcText = sources[unitId] ?? ''
      const hit = pattern ? pattern.test(srcText) : srcText.includes(source)
      if (hit && !translation.includes(target)) {
        misses.push({ unit_id: unitId, term: source, target, translation })
      }
    }
  }
  return misses
}

/** 一致性审计：同源句不同译文。返回冲突组。 */
export function consistencyAudit(
  translations: Record<string, string>,
  sources: Record<string, string>,
): Array<{ source: string; variants: Record<string, string> }> {
  const groups: Record<string, Record<string, string>> = {}
  for (const [unitId, translation] of Object.entries(translations)) {
    const src = sources[unitId] ?? ''
    if (!src) continue
    ;(groups[src] ??= {})[unitId] = translation
  }
  const conflicts: Array<{ source: string; variants: Record<string, string> }> = []
  for (const [source, items] of Object.entries(groups)) {
    if (new Set(Object.values(items)).size > 1) {
      conflicts.push({ source, variants: items })
    }
  }
  return conflicts
}

/** 字符串翻译标签保真：old 含 {#tag} 而译文未携带时，把标签补到译文头部。 */
export function ensureTranslationTag(old: string, translation: string): string {
  if (!translation) return translation
  const tags = old.match(TEMP_TAG_RE) ?? []
  if (tags.length === 0 || TEMP_TAG_RE.test(translation)) return translation
  return tags.join('') + translation
}

const SPEAKER_PREFIX_RE = /^\[([A-Za-z_][A-Za-z0-9_]*)\]\s?/

/**
 * 清理译文开头的 [speaker] 残留前缀。
 * 仅当源文本中不存在该 [xxx] 标记时清理；清理后为空则保留原文，避免吞掉整个译文。
 */
export function stripLeadingSpeakerTag(source: string, translation: string): string {
  const m = SPEAKER_PREFIX_RE.exec(translation)
  if (!m) return translation
  const tag = `[${m[1]}]`
  if (source.includes(tag)) return translation
  const rest = translation.slice(m[0].length).trimStart()
  return rest || translation
}
