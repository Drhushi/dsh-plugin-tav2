/**
 * 候选字体枚举（纯 TS，离线）：三来源（游戏自带 / 系统已装 / 手动路径）+ 启发式
 * （CJK 覆盖 / 版权风险）+ 元数据读取 + 去重。任何目录不可读都静默跳过（不阻断）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readFontMeta, type FontMeta } from './ttf'

export type FontSource = 'game' | 'system' | 'manual'

export interface FontCandidate {
  /** 稳定 id（源文件名净化 stem，去重/挑选用）。 */
  id: string
  /** 展示名：fullName > family > 文件 stem。 */
  name: string
  source: FontSource
  path: string
  family?: string
  weight?: number
  copyright?: string
  /** 启发式判定是否覆盖 CJK。 */
  cjk: boolean
  /** 有再分发风险（Windows 专有字体黑名单）。 */
  risky: boolean
  /** 元数据可读；不可读时保留（名称为文件名兜底），仅详情字段缺失。 */
  metaOk: boolean
  ext: string
}

export const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc']

/** 文件名片段：命中即视为 CJK 字体（与 verify.ts 的启发式一致，并补充常见项）。 */
export const CJK_FONT_HINTS = [
  'noto', 'wqy', 'sourcehan', 'source_han', '思源', 'msyh', 'simhei', 'simsun',
  'yahei', 'cjk', 'simkai', 'simfang', 'dengxian', 'mingliu', 'songti', 'heiti',
]

/** 家族/全名里的强 CJK 标记（元数据兜底；避免 'sc'/'cn' 这类过宽子串）。 */
const CJK_NAME_HINTS = [
  'noto', 'source han', '思源', 'wenquanyi', 'wqy', 'cjk', 'yahei', 'simhei',
  'simsun', 'simkai', 'simfang', 'dengxian', 'ming', 'gothic', 'songti', 'heiti',
]

/** 有再分发风险的 Windows 专有/受限字体文件名片段。 */
export const RISKY_FONT_HINTS = [
  'msyh', 'msjh', 'simhei', 'simsun', 'simkai', 'simfang', 'dengxian', 'mingliu',
  'mtcorsva', 'arial unicode',
]

/** 净化文件名 stem：去扩展名、小写、非字母数字转连字符、压缩连字符。纯非 ASCII 名退回确定性 hash。 */
export function sanitizeStem(filename: string): string {
  const base = basename(filename)
  const noExt = base.replace(/\.[^.]+$/, '')
  const cleaned = noExt.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned) return cleaned
  // 纯非 ASCII 文件名（如中文「思源黑体.ttf」）：退回确定性 hash，保证非空、稳定、可回查。
  return `font-${createHash('sha256').update(noExt).digest('hex').slice(0, 10)}`
}

/** 判断字体是否覆盖 CJK（文件名 hint 优先，元数据兜底）。 */
export function isCjkFont(filename: string, meta?: FontMeta | null): boolean {
  const lower = filename.toLowerCase()
  if (CJK_FONT_HINTS.some((h) => lower.includes(h))) return true
  if (meta) {
    const hay = `${meta.family} ${meta.fullName}`.toLowerCase()
    if (CJK_NAME_HINTS.some((h) => hay.includes(h))) return true
  }
  return false
}

/** 判断字体文件是否有再分发风险。 */
export function isRiskyFont(filename: string): boolean {
  const lower = filename.toLowerCase()
  return RISKY_FONT_HINTS.some((h) => lower.includes(h))
}

/** 系统字体目录（Windows）；无法确定时返回 Windows 默认路径。 */
export function systemFontDir(): string {
  const windir = process.env.WINDIR || process.env.windir
  return windir ? join(windir, 'Fonts') : join('C:', 'Windows', 'Fonts')
}

/** game 目录含 game/ 子目录时返回 game/，否则原样。 */
export function resolveGameDir(gameDir: string): string {
  const g = join(gameDir, 'game')
  return existsSync(g) && statIsDir(g) ? g : gameDir
}

function statIsDir(path: string): boolean {
  try {
    return readdirSync(path).length >= 0
  } catch {
    return false
  }
}

export interface ScanDirOptions {
  /** 是否递归子目录（系统字体目录通常扁平）。 */
  recursive?: boolean
  maxDepth?: number
  /** 跳过的目录名（任何层级）。 */
  skipDirs?: string[]
}

function scanFontDirInto(
  dir: string,
  source: FontSource,
  out: FontCandidate[],
  opts: ScanDirOptions,
  depth: number,
): void {
  let entries: { name: string; isDir: boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }))
  } catch {
    return
  }
  const skip = new Set(opts.skipDirs ?? [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDir) {
      if (opts.recursive !== false && depth < (opts.maxDepth ?? 4) && !skip.has(entry.name)) {
        scanFontDirInto(full, source, out, opts, depth + 1)
      }
      continue
    }
    const ext = extname(entry.name).toLowerCase()
    if (!FONT_EXTENSIONS.includes(ext)) continue
    const meta = readFontMeta(full)
    const id = sanitizeStem(entry.name)
    out.push({
      id,
      name: meta?.fullName || meta?.family || id,
      source,
      path: full,
      ...(meta?.family ? { family: meta.family } : {}),
      ...(meta?.weight !== undefined ? { weight: meta.weight } : {}),
      ...(meta?.copyright ? { copyright: meta.copyright } : {}),
      cjk: isCjkFont(entry.name, meta),
      risky: isRiskyFont(entry.name),
      metaOk: meta !== null,
      ext,
    })
  }
}

export interface EnumerateOptions {
  /** 手动字体目录（config fonts.dir）。 */
  dir?: string
  /** 系统字体目录；缺省用 systemFontDir()。 */
  systemDir?: string
  /** 是否扫描系统目录（默认 true）。 */
  includeSystem?: boolean
  /** 仅返回 CJK 候选。 */
  cjkOnly?: boolean
}

/**
 * 枚举候选字体，来源优先级：game > manual > system（同文件只保留首个）。
 * 返回按 id 排序；任何来源目录不存在/不可读静默跳过。
 */
export function enumerateFonts(gameDir: string, opts: EnumerateOptions = {}): FontCandidate[] {
  const candidates: FontCandidate[] = []
  const gameRoot = resolveGameDir(gameDir)

  const push = (dir: string | null | undefined, source: FontSource, scanOpts: ScanDirOptions): void => {
    if (!dir) return
    scanFontDirInto(dir, source, candidates, scanOpts, 0)
  }

  push(gameDir, 'game', { recursive: true, skipDirs: ['tl', 'renpy', 'cache'] })
  if (gameRoot !== gameDir) push(gameRoot, 'game', { recursive: true, skipDirs: ['tl', 'renpy', 'cache'] })
  push(opts.dir, 'manual', { recursive: true, maxDepth: 2 })
  const sysDir = opts.systemDir ?? systemFontDir()
  if (opts.includeSystem !== false && sysDir) push(sysDir, 'system', { recursive: false })

  const seen = new Set<string>()
  const deduped: FontCandidate[] = []
  for (const c of candidates) {
    if (seen.has(c.path)) continue
    seen.add(c.path)
    deduped.push(c)
  }

  const out = opts.cjkOnly ? deduped.filter((c) => c.cjk) : deduped
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
