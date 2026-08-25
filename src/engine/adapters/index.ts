/**
 * 引擎适配器注册表：自移除多引擎支持后仅注册 Ren'Py。
 * detect 保留一个轻量「识别但拒绝」分支：认出 Unity/Yarn 布局时明确提示
 * 插件已仅支持 Ren'Py，避免用户把「刻意移除」误当成探测失败。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renpyAdapter } from './renpy/adapter'
import type { DetectResult, EngineAdapter, EngineKind } from './types'

export type {
  DetectResult, DiffResult, EngineAdapter, EngineKind, EngineRuntime, ExtractResult, InjectResult, CoverageReport,
  RuntimeCheck, RuntimeCheckOptions, RuntimeMode, RuntimeModeKind, RuntimeRequirement,
} from './types'
export { renpyAdapter }

const registered: EngineAdapter[] = [renpyAdapter]

const SHARED_ASSET_RE = /^sharedassets\d*\.assets$/
const RESOURCE_ASSET_RE = /^(?:resources|globalgamemanagers)\.assets$/

/**
 * 识别 Unity/Yarn 游戏布局（只读文件名探测，不解析内容）。
 * 命中时返回一个带明确「已仅支持 Ren'Py」提示的拒绝结果（detected=false）；
 * 未命中返回 null（非 Unity 布局）。
 */
function detectLegacyUnity(gameRoot: string): DetectResult | null {
  let assetFound = false
  let dataDir = ''
  try {
    for (const entry of readdirSync(gameRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('_Data')) continue
      try {
        for (const name of readdirSync(join(gameRoot, entry.name))) {
          if (SHARED_ASSET_RE.test(name) || RESOURCE_ASSET_RE.test(name)) {
            assetFound = true
            dataDir = entry.name
            break
          }
        }
      } catch {
        // 该数据目录读不了，继续
      }
      if (assetFound) break
    }
  } catch {
    return null
  }
  if (!assetFound) return null
  return {
    engine: 'unknown',
    detected: false,
    gameRoot,
    confidence: 0.6,
    layout: { unsupported: 'unity-yarn', dataDir },
    message: '识别到 Unity/Yarn 游戏布局，但 dsh-plugin-tav2 已移除 Unity/Yarn 支持、仅支持 Ren\'Py'
      + '（v0.x 起收敛为单引擎，刻意移除而非探测失败，详见 README）。',
  }
}

/** 按顺序探测引擎；Ren'Py 未命中且是 Unity 布局时给出「识别但拒绝」提示；其余返回 unknown。 */
export function detectEngine(gameRoot: string): DetectResult {
  for (const adapter of registered) {
    const result = adapter.detect(gameRoot)
    if (result.detected) return result
  }
  const legacy = detectLegacyUnity(gameRoot)
  if (legacy) return legacy
  return {
    engine: 'unknown',
    detected: false,
    gameRoot,
    confidence: 0,
    layout: {},
    message: '未识别到已知游戏引擎布局（当前仅支持 Ren\'Py）',
  }
}
