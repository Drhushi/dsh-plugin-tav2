/**
 * TTF/OTF/TTC 元数据读取（纯 TS，离线）。
 *
 * 解析 sfnt 头 + 'name' 表，抽取家族/子族/全名/版权；子族关键词启发式映射字重。
 * 任何结构性失败返回 null（fail-closed，不抛错），由调用方按文件名兜底。
 * 支持：TrueType（0x00010000）/ OTTO（CFF）/ 'true' 头，以及 TTC 集合（取第一个字体）。
 */
import { readFileSync } from 'node:fs'

export interface FontMeta {
  family: string
  subfamily: string
  fullName: string
  copyright: string
  /** 从子族关键词启发式推断的字重（100–900），推断不出为 undefined。 */
  weight?: number
}

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16BE(off)
}

function u32(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off)
}

/** 子族关键词 → 字重（按特异性从高到低，先命中先返回）。 */
const WEIGHT_HINTS: Array<[RegExp, number]> = [
  [/black|heavy/i, 900],
  [/extrabold|ultrabold/i, 800],
  [/bold/i, 700],
  [/semibold|demibold/i, 600],
  [/medium/i, 500],
  [/regular|normal|book/i, 400],
  [/light/i, 300],
  [/thin|hairline/i, 100],
]

/** 从子族字符串推断字重。 */
export function weightFromSubfamily(subfamily: string): number | undefined {
  for (const [re, weight] of WEIGHT_HINTS) {
    if (re.test(subfamily)) return weight
  }
  return undefined
}

/** 手工解码 UTF-16BE（Buffer 无 utf16be 编码，TTF 'name' 表字符串为大端）。 */
function decodeUtf16be(slice: Buffer): string {
  let out = ''
  for (let i = 0; i + 1 < slice.length; i += 2) {
    out += String.fromCharCode(u16(slice, i))
  }
  return out
}

/** 从字符串区解析一条 name 记录（越界返回 null）。 */
function parseNameString(
  buf: Buffer,
  nameBase: number,
  stringOffset: number,
  offset: number,
  length: number,
): string | null {
  const start = nameBase + stringOffset + offset
  if (start < 0 || start + length > buf.length) return null
  const slice = buf.subarray(start, start + length)
  if (slice.length === 0) return ''
  // Windows/Unicode 平台按 UTF-16BE；通过首字节特征粗判（常见 UTF-16 文本首字节为 0x00）；
  // 否则按 Latin-1 兜底（Mac 平台）。
  const looksUtf16 = slice[0] === 0x00
  if (looksUtf16) {
    try {
      return decodeUtf16be(slice)
    } catch {
      return null
    }
  }
  return slice.toString('latin1')
}

interface ParsedNameTable {
  copyright: string
  family: string
  subfamily: string
  fullName: string
}

/** 解析 'name' 表（支持 format 0/1）。 */
function parseNameTable(buf: Buffer, nameOff: number, nameLen: number): ParsedNameTable | null {
  if (nameOff < 0 || nameOff + nameLen > buf.length) return null
  if (nameLen < 6) return null
  const format = u16(buf, nameOff)
  if (format > 1) return null
  const count = u16(buf, nameOff + 2)
  const stringOffset = u16(buf, nameOff + 4)
  // format 1 在 name 记录前有一组 langTag 记录（每条 4 字节）。
  const langTagCount = format === 1 ? u16(buf, nameOff + 6) : 0
  const recordsBase = nameOff + (format === 1 ? 8 + langTagCount * 4 : 6)
  if (recordsBase + count * 12 > nameOff + nameLen) return null

  const found: Partial<Record<number, string>> = {}
  const qualityOf: Record<number, number> = {}
  for (let i = 0; i < count; i += 1) {
    const rec = recordsBase + i * 12
    const platformID = u16(buf, rec)
    const nameID = u16(buf, rec + 6)
    if (!(nameID === 0 || nameID === 1 || nameID === 2 || nameID === 4)) continue
    const length = u16(buf, rec + 8)
    const offset = u16(buf, rec + 10)
    // 平台优先级：Windows(3)/Unicode(0) > Mac(1) > 其它；同 nameID 仅接受更高优先级记录。
    const quality = platformID === 3 || platformID === 0 ? 2 : platformID === 1 ? 1 : 0
    if ((qualityOf[nameID] ?? -1) >= quality) continue
    const value = parseNameString(buf, nameOff, stringOffset, offset, length)
    if (value !== null) {
      found[nameID] = value
      qualityOf[nameID] = quality
    }
  }

  return {
    copyright: found[0] ?? '',
    family: found[1] ?? '',
    subfamily: found[2] ?? '',
    fullName: found[4] ?? '',
  }
}

/** 解析单个字体（base = sfnt 起始偏移）。表内偏移相对 base。 */
function parseSfnt(buf: Buffer, base: number): FontMeta | null {
  if (base < 0 || base + 12 > buf.length) return null
  const numTables = u16(buf, base + 4)
  if (numTables === 0 || numTables > 512) return null
  let nameOff = -1
  let nameLen = 0
  for (let i = 0; i < numTables; i += 1) {
    const rec = base + 12 + i * 16
    if (rec + 16 > buf.length) return null
    const tag = buf.toString('latin1', rec, rec + 4)
    if (tag === 'name') {
      // 表数据偏移相对该字体的 sfnt 起始（TTC 成员字体 base≠0）。
      nameOff = base + u32(buf, rec + 8)
      nameLen = u32(buf, rec + 12)
    }
  }
  if (nameOff < 0) return null
  const parsed = parseNameTable(buf, nameOff, nameLen)
  if (!parsed) return null
  const weight = weightFromSubfamily(parsed.subfamily)
  return {
    family: parsed.family,
    subfamily: parsed.subfamily,
    fullName: parsed.fullName,
    copyright: parsed.copyright,
    ...(weight !== undefined ? { weight } : {}),
  }
}

/**
 * 读取字体文件元数据；无法识别/损坏返回 null。
 * TTC 集合取第一个字体的元数据。
 */
export function readFontMeta(path: string): FontMeta | null {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return null
  }
  if (buf.length < 12) return null
  const tag = buf.toString('latin1', 0, 4)
  try {
    if (tag === 'ttcf') {
      if (buf.length < 16) return null
      const numFonts = u32(buf, 8)
      if (numFonts < 1) return null
      const firstOffset = u32(buf, 12)
      return parseSfnt(buf, firstOffset)
    }
    if (tag === '\x00\x01\x00\x00' || tag === 'OTTO' || tag === 'true') {
      return parseSfnt(buf, 0)
    }
    return null
  } catch {
    return null
  }
}
