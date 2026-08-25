/**
 * 把译文回填到 tl/<语言>/*.rpy。
 * 移植自 tav2 的 adapters/renpy/backfill.py（backfill_machine）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { parseTlDirectory, rebuildChunk, tlRoot } from './tlparser'

/**
 * dialogue_map 的结构：键为 `${filename}|${identifier}`，值为 say_index -> 译文。
 * string_map 的结构：键为 `${filename}|${old}`，值为译文。
 * 既接受 Map 也接受嵌套 Record/扁平 Record。
 */
export type DialogueMapInput =
  | Map<string, Map<string | number, string>>
  | Record<string, Record<string | number, string>>

export type StringMapInput = Map<string, string> | Record<string, string>

export interface BackfillStats {
  applied: number
  skipped: number
  unchanged: number
}

/** 规范化 dialogue_map 为 (filename, identifier, say_index -> 译文) 列表。 */
function normalizeDialogue(input: DialogueMapInput): Array<[string, string, Map<number, string>]> {
  const out: Array<[string, string, Map<number, string>]> = []
  if (input instanceof Map) {
    for (const [key, inner] of input) {
      const [filename, identifier] = splitKey(key)
      const perSay = new Map<number, string>()
      for (const [k, v] of inner) perSay.set(Number(k), v)
      out.push([filename, identifier, perSay])
    }
    return out
  }
  for (const [key, inner] of Object.entries(input)) {
    const [filename, identifier] = splitKey(key)
    const perSay = new Map<number, string>()
    for (const [k, v] of Object.entries(inner)) perSay.set(Number(k), String(v))
    out.push([filename, identifier, perSay])
  }
  return out
}

/** 规范化 string_map 为 (filename, old, translation) 列表。 */
function normalizeStrings(input: StringMapInput): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = []
  if (input instanceof Map) {
    for (const [key, translation] of input) {
      const [filename, old] = splitKey(key)
      out.push([filename, old, translation])
    }
    return out
  }
  for (const [key, translation] of Object.entries(input)) {
    const [filename, old] = splitKey(key)
    out.push([filename, old, String(translation)])
  }
  return out
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf('|')
  if (idx < 0) return [key, '']
  return [key.slice(0, idx), key.slice(idx + 1)]
}

function toPosixRel(file: string, root: string): string {
  return relative(root, file).split(sep).join('/')
}

/**
 * 直写模式：按 (文件名, 标识符) -> {行号: 译文} 与 (文件名, old) -> 译文 回填 tl。
 * 返回统计 {applied, skipped, unchanged}（与 Python 基线一致：applied=写入文件数，skipped/unchanged 恒 0）。
 */
export function backfillMachine(
  gameDir: string,
  lang: string,
  dialogueMap: DialogueMapInput,
  stringMap: StringMapInput,
): BackfillStats {
  const normalizedDialogue = normalizeDialogue(dialogueMap)
  const normalizedStrings = normalizeStrings(stringMap)

  const dialogueByFile = new Map<string, Map<string, Map<number, string>>>()
  for (const [filename, identifier, perSay] of normalizedDialogue) {
    if (!dialogueByFile.has(filename)) dialogueByFile.set(filename, new Map())
    dialogueByFile.get(filename)!.set(identifier, perSay)
  }

  const files = parseTlDirectory(gameDir, lang)
  const stats: BackfillStats = { applied: 0, skipped: 0, unchanged: 0 }
  const root = tlRoot(gameDir, lang)

  for (const [path, chunks] of files) {
    const rel = toPosixRel(path, root)
    const perFileDialogue = dialogueByFile.get(rel)
    const perFileStrings = normalizedStrings
      .filter(([filename]) => filename === rel)
      .map(([, old, translation]) => [old, translation] as [string, string])

    let changed = false
    const newChunks: string[][] = []
    for (const chunk of chunks) {
      let sayTranslations: Map<number, string> | undefined
      if (chunk.kind === 'dialogue') {
        const perSay = perFileDialogue?.get(chunk.identifier ?? '')
        if (perSay && perSay.size > 0) sayTranslations = perSay
      }
      const stringMapForFile =
        perFileStrings.length > 0 ? new Map(perFileStrings) : undefined
      const rebuilt = rebuildChunk(chunk, sayTranslations, stringMapForFile)
      if (rebuilt.join('\n') !== chunk.raw.join('\n')) changed = true
      newChunks.push(rebuilt)
    }

    if (!changed) continue
    const text = readFileSync(path, 'utf8')
    const trailing = text.endsWith('\n') ? '\n' : ''
    const body = newChunks.map((chunkLines) => chunkLines.join('\n')).join('\n')
    writeFileSync(path, body + trailing, 'utf8')
    stats.applied += 1
  }

  return stats
}
