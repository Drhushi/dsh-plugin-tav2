/**
 * 工作区配置项目发现（纯逻辑，不依赖 dsh，可离线单测）。
 *
 * 有界递归（默认最多 3 层，根自身 depth 0）在工作区下找 config.yaml 项目，
 * 忽略黑名单目录（.git / node_modules 等），不跟随符号链接（防环）。
 * 作用域分级（translation_scope/select_project 的 applyWorkspaceCwd）与
 * /tav2/panel 路由共用同一套，保证「已配置工作区（含母文件夹深层子项目）」
 * 能被一致识别为翻译项目，不再因嵌套深一层就误判为普通工作区。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** 当前适配器支持的引擎（与 assertSupportedEngine 对齐；只实现 Ren'Py）。 */
const SUPPORTED_ENGINES = new Set(['renpy'])

/** 轻量读取 config.yaml 顶层 `key: value`（tav2 配置足够，不引 yaml 依赖）。 */
function readConfigKey(configPath: string, key: string): string | undefined {
  try {
    const text = readFileSync(configPath, 'utf8')
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm'))
    if (!m) return undefined
    const val = (m[1] ?? '').trim()
    return val === '' ? undefined : val
  } catch {
    return undefined
  }
}

/**
 * 仅当 config.yaml 是「真 tav2 项目」才作为候选：
 * - 有 `engine:` 字段 → 须为受支持引擎（renpy；unity-yarn/novel 等 fail-closed 不算）；
 * - 缺 `engine:` → 回退：有 `game_dir:` 视为项目（兼容最简配置）。
 * 无关应用的 config.yaml（clash / 各类工具，无 engine/game_dir）一律不算，防候选污染。
 */
export function isTav2Config(configPath: string): boolean {
  const engine = readConfigKey(configPath, 'engine')
  if (engine !== undefined) return SUPPORTED_ENGINES.has(engine.toLowerCase())
  return readConfigKey(configPath, 'game_dir') !== undefined
}

/** 发现到的配置项目。 */
export interface DiscoveredProject {
  /** 含 config.yaml 的目录（绝对路径）。 */
  dir: string
  /** config.yaml 完整路径。 */
  configPath: string
  /** 发现深度：0=根自身，1=直接子目录，2=孙目录，…… */
  depth: number
}

export interface DiscoverOptions {
  /** 最大深度（含根自身 depth 0）；默认 3（即最多扫到曾孙目录）。 */
  maxDepth?: number
  /** 忽略的目录名（任意深度命中即整棵跳过）；默认 .git / node_modules / .cache。 */
  ignore?: ReadonlySet<string>
}

const DEFAULT_IGNORE = new Set(['.git', 'node_modules', '.cache'])

/** 在工作区下（含根自身）有界递归发现所有 config.yaml 项目，按 dir 升序返回。 */
export function discoverConfigProjects(root: string, options?: DiscoverOptions): DiscoveredProject[] {
  const maxDepth = options?.maxDepth ?? 3
  const ignore = options?.ignore ?? DEFAULT_IGNORE
  const out: DiscoveredProject[] = []
  if (!root || !isAbsolute(root)) return out
  try {
    if (!statSync(root).isDirectory()) return out
  } catch {
    return out
  }
  walk(root, 0)
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return
    const configPath = join(dir, 'config.yaml')
    try {
      // 只认「真 tav2 项目」：config.yaml 为文件且内容通过校验（engine 受支持 / 缺 engine 但有 game_dir）。
      if (statSync(configPath).isFile() && isTav2Config(configPath)) out.push({ dir, configPath, depth })
    } catch {
      // 无 config.yaml，继续向下。
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // 只深入真实目录：isDirectory() 对符号链接为 false，天然防环。
      if (!entry.isDirectory()) continue
      if (ignore.has(entry.name)) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
}
