/**
 * 运行时证据收集（src/engine/runtime，不依赖 dsh）。
 *
 * 「写文件成功 ≠ 翻译生效」——本模块为 Ren'Py 适配器/verify 提供读取运行时日志、
 * 提取关键证据的纯工具（如 traceback.txt 等）。不做命中率统计（v2 再扩展）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

/** 读取一组日志路径，合并为文本（缺失/读失败静默忽略）。 */
export function readLogs(paths: string[]): string {
  const parts: string[] = []
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).size > 0) parts.push(readFileSync(p, 'utf8'))
    } catch {
      // 单个日志读不了不阻断整体
    }
  }
  return parts.join('\n')
}

/** 是否存在非空日志证据（至少一个日志文件有内容）。 */
export function hasLogEvidence(paths: string[]): boolean {
  return paths.some((p) => {
    try {
      return existsSync(p) && statSync(p).size > 0
    } catch {
      return false
    }
  })
}

/** 日志文本是否命中正则。 */
export function logHas(logText: string, pattern: RegExp): boolean {
  return pattern.test(logText)
}
