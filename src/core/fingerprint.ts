/**
 * 版本指纹快照（src/core，不依赖 dsh）。
 *
 * 目标：把翻译与具体游戏版本绑定。对 Ren'Py 提取输入（game 脚本 .rpy/.rpyc/.rpa）
 * 做 sha256 指纹，叠加 changelog.txt / exe 的显示版本，存进项目 DB meta 与 work 目录 JSON。
 * 更新后比对指纹即可判断「游戏是否已更新」，为后续按稳定 ID 的增量迁移
 * （tav2_migrate，下一专项）提供基线。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

/** 单个源文件（统一正斜杠绝对路径）。 */
export interface FingerprintSource {
  path: string
  sha256: string
}

/** 一次完整版本指纹快照。 */
export interface GameFingerprint {
  engine: string
  gameRoot: string
  displayVersion: string
  fingerprint: string
  sources: FingerprintSource[]
  createdAt: string
}

/** 项目 DB meta 的读写面（ProjectDB 结构满足此接口）。 */
export interface MetaStore {
  getMeta(key: string): string
  setMeta(key: string, value: string): void
}

export const FINGERPRINT_CURRENT_KEY = 'fingerprint.current'
export const FINGERPRINT_HISTORY_KEY = 'fingerprint.history'
const HISTORY_CAP = 20

/** 文件 sha256（hex）。 */
export function hashFile(path: string): string {
  const buf = readFileSync(path)
  return createHash('sha256').update(buf).digest('hex')
}

/** 文本 sha256（utf8，hex）。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 递归收集 renpy 的提取输入（.rpy/.rpyc/.rpa），优先 game/ 目录。 */
function collectRenpySources(gameRoot: string): string[] {
  const root = existsSync(join(gameRoot, 'game')) ? join(gameRoot, 'game') : gameRoot
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: { name: string; isDir: boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }))
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDir) {
        // Ren'Py 翻译目录 game/tl/：其模板/译文是插件输出产物，不计入源文件指纹
        // （否则 prepare 后 tl 变化会被误判为「游戏可能已更新」）。
        if (entry.name !== 'tl') stack.push(full)
      } else if (/\.(rpy|rpyc|rpa)$/i.test(entry.name)) out.push(full)
    }
  }
  return out.sort()
}

/** 收集引擎的提取输入文件（绝对路径，排序；不存在则跳过）。仅 Ren'Py。 */
export function collectSourceFiles(engine: string, gameRoot: string): string[] {
  if (engine === 'renpy') return collectRenpySources(gameRoot)
  return []
}

/** 主可执行文件（.exe）路径，无则 null。 */
function findGameExe(gameRoot: string): string | null {
  try {
    const names = readdirSync(gameRoot).filter((n) => /\.exe$/i.test(n))
    return names.length > 0 ? join(gameRoot, names[0]!) : null
  } catch {
    return null
  }
}

/** 尽力读 exe 文件版本（仅 win32，失败静默）。 */
function probeExeFileVersion(exePath: string): string {
  if (process.platform !== 'win32') return ''
  try {
    const script = `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 4000,
      windowsHide: true,
      encoding: 'utf8',
    })
    const v = String(res.stdout ?? '').trim()
    return v && !/Exception|error/i.test(v) ? v : ''
  } catch {
    return ''
  }
}

/** 读取显示版本：changelog.txt 首行优先；其次 exe FileVersion；兜底 unknown。 */
export function readDisplayVersion(gameRoot: string): string {
  const changelog = join(gameRoot, 'changelog.txt')
  try {
    if (existsSync(changelog)) {
      const first = readFileSync(changelog, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      if (first) return first
    }
  } catch {
    // 忽略：走 exe 探测
  }
  const exe = findGameExe(gameRoot)
  if (exe) {
    const v = probeExeFileVersion(exe)
    if (v) return v
  }
  return 'unknown'
}

/** 对源清单求确定性指纹：按相对路径排序拼接 rel\0hash。 */
export function sourcesFingerprint(sources: FingerprintSource[], gameRoot: string): string {
  const root = gameRoot.replace(/\\/g, '/')
  const h = createHash('sha256')
  for (const s of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = relative(root, s.path) || basename(s.path)
    h.update(`${rel}\u0000${s.sha256}\n`)
  }
  return h.digest('hex')
}

/** 计算当前游戏版本指纹。 */
export function computeGameFingerprint(
  engine: string,
  gameRoot: string,
  now = new Date().toISOString(),
): GameFingerprint {
  const sources = collectSourceFiles(engine, gameRoot).map((path) => ({
    path: path.replace(/\\/g, '/'),
    sha256: hashFile(path),
  }))
  return {
    engine,
    gameRoot: gameRoot.replace(/\\/g, '/'),
    displayVersion: readDisplayVersion(gameRoot),
    fingerprint: sourcesFingerprint(sources, gameRoot),
    sources,
    createdAt: now,
  }
}

/** 指纹是否变化（即游戏源文件可能已更新）。 */
export function fingerprintChanged(prev: GameFingerprint, cur: GameFingerprint): boolean {
  return prev.fingerprint !== cur.fingerprint
}

/** 列出发生变更的源文件（相对/绝对路径，排序）：新增/删除/内容变化。 */
export function changedSourcePaths(prev: GameFingerprint, cur: GameFingerprint): string[] {
  const curByPath = new Map(cur.sources.map((s) => [s.path, s.sha256]))
  const prevByPath = new Map(prev.sources.map((s) => [s.path, s.sha256]))
  const out: string[] = []
  for (const [p, hash] of curByPath) {
    if (!prevByPath.has(p) || prevByPath.get(p) !== hash) out.push(p)
  }
  for (const p of prevByPath.keys()) {
    if (!curByPath.has(p)) out.push(p)
  }
  return out.sort()
}

/** 读取 DB 中的最近快照；无/损坏返回 null。 */
export function readFingerprintSnapshot(meta: MetaStore): GameFingerprint | null {
  const raw = meta.getMeta(FINGERPRINT_CURRENT_KEY)
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as GameFingerprint
    if (typeof obj.fingerprint !== 'string' || !Array.isArray(obj.sources)) return null
    return obj
  } catch {
    return null
  }
}

/** 写入快照：DB meta（current + history，上限 20）+ work 目录 fingerprint.json。 */
export function storeFingerprintSnapshot(
  meta: MetaStore,
  projectDir: string,
  fp: GameFingerprint,
): void {
  meta.setMeta(FINGERPRINT_CURRENT_KEY, JSON.stringify(fp))
  let history: GameFingerprint[] = []
  try {
    const raw = JSON.parse(meta.getMeta(FINGERPRINT_HISTORY_KEY) || '[]')
    if (Array.isArray(raw)) history = raw as GameFingerprint[]
  } catch {
    history = []
  }
  const last = history[history.length - 1]
  if (!last || last.fingerprint !== fp.fingerprint) {
    history.push(fp)
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP)
    meta.setMeta(FINGERPRINT_HISTORY_KEY, JSON.stringify(history))
  }
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'fingerprint.json'), `${JSON.stringify(fp, null, 2)}\n`, 'utf8')
}
