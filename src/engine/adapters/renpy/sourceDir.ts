/**
 * 编译版 Ren'Py 游戏的反编译源码参考目录约定。
 *
 * 新链路（prepare 重构后）：tl 译文直接写在真实游戏目录 game/tl/<lang>，
 * 反编译源码参考放 <游戏根>/tav2_src/（引擎不加载它，仅供 gui 变量确认、
 * label 映射、排查，结项封包时可清理）。真实游戏目录与指纹/路由扫描只看
 * game/ 子目录，因此 tav2_src 放在游戏根不会污染指纹与 prepare 路由。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 把 gameDir 归一化到 game/ 子目录（与 tlparser.resolveGameDir 同语义）。 */
function resolveGameDir(gameDir: string): string {
  const g = join(gameDir, 'game')
  return existsSync(g) && statSync(g).isDirectory() ? g : gameDir
}

/**
 * 返回存在的反编译源码参考 game 目录（当前约定 <游戏根>/tav2_src/game）。
 * gameDir 指向游戏根或 game/ 子目录均可识别。无则返回空数组。
 */
export function resolveSourceGameDirs(gameDir: string): string[] {
  if (!gameDir) return []
  const g = resolveGameDir(gameDir)
  const conventional = join(dirname(g), 'tav2_src', 'game')
  return existsSync(conventional) ? [conventional] : []
}

/** 源码参考目录根（<游戏根>/tav2_src），供封包清场删除；无 gameDir 返回 null。 */
export function resolveSourceRoot(gameDir: string): string | null {
  if (!gameDir) return null
  return join(dirname(resolveGameDir(gameDir)), 'tav2_src')
}
