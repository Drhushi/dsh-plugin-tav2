/**
 * 质量门禁：标签保持、术语审计、反翻译腔、一致性审计。
 * 从 tav2/gates.py 移植；另含 ensure_translation_tag（tav2/renpy_compat）。
 */

const BRACE_TAG_RE = /\{[^{}\n]*\}/g
const BRACKET_TAG_RE = /\[[^\]\n]+\]/g
const TEMP_TAG_RE = /\{\#[^{}\n]*\}/g

/** 提取 Ren'Py 文本标签与插值；以及 %% / {{ / }} / \\n 转义计数。 */
export function renpyTokens(text: string): { tags: Set<string>; escapes: number } {
  const tags = new Set<string>()
  for (const m of text.matchAll(BRACE_TAG_RE)) tags.add(m[0])
  for (const m of text.matchAll(BRACKET_TAG_RE)) tags.add(m[0])
  const escapes = text.split('%%').length - 1
    + text.split('{{').length - 1
    + text.split('}}').length - 1
    + text.split('\\n').length - 1
  return { tags, escapes }
}

/**
 * 校验译文是否原样保留源文本中的 Ren'Py 标签、插值与转义。
 * {#tag} 是确定性可恢复的临时标签，不强制 LLM 携带（回填时自动补回）。
 */
export function tagsPreserved(source: string, translation: string): boolean {
  const src = renpyTokens(source)
  if (src.tags.size === 0 && src.escapes === 0) return true
  const dst = renpyTokens(translation)
  const required = [...src.tags].filter((t) => !t.startsWith('{#'))
  const allPresent = required.every((t) => dst.tags.has(t))
  return allPresent && dst.escapes >= src.escapes
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
