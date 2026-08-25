/** token 估算工具（与 Python tav2/tokens.py 同口径）。 */

const WORD_RE = /[A-Za-z0-9_]+/g
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g

/** 粗略估计 token 数：英文单词约 1.3 token/词，中日韩字符按 1 token/字。 */
export function estimateTokens(text: string): number {
  const words = text.match(WORD_RE) ?? []
  const cjk = text.match(CJK_RE) ?? []
  const wordChars = words.reduce((n, w) => n + w.length, 0)
  const other = text.length - wordChars - cjk.length
  return Math.floor(words.length * 1.3 + cjk.length + other * 0.25) + 1
}
