/**
 * 引擎适配器注册表：当前适配 Ren'Py；架构保留多引擎扩展面（EngineAdapter 接口 + 注册表）。
 * detect 保留一个轻量「识别但暂不可用」分支：认出 Unity/Yarn 布局时明确提示
 * 当前适配器仅实现 Ren'Py，避免用户把「暂未适配」误当成探测失败。
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
 * 命中时返回一个带明确「当前适配器仅实现 Ren'Py」提示的拒绝结果（detected=false）；
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
    message: '识别到 Unity/Yarn 游戏布局。dsh-plugin-tav2 当前适配器仅实现 Ren\'Py，暂无法处理该引擎'
      + '（架构保留多引擎扩展面，待对应适配器落地）。',
  }
}

/** 按顺序探测引擎；Ren'Py 未命中且是 Unity 布局时给出「识别但暂不可用」提示；其余返回 unknown。 */
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
    message: '未识别到已知游戏引擎布局（当前适配器仅实现 Ren\'Py）',
  }
}
