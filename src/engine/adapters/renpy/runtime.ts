/** Ren'Py 的最小运行时判据：无 hook 层，主要靠加载证据与崩溃/字体提示。 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasLogEvidence, logHas, readLogs } from '../../runtime/canary'
import type { EngineRuntime, RuntimeCheck, RuntimeMode, RuntimeRequirement } from '../types'

export const renpyRuntime: EngineRuntime = {
  modeOf(gameRoot: string, lang?: string): RuntimeMode {
    const langDir = lang ?? 'chinese'
    return {
      kind: 'renpy-tl',
      translationDir: join(gameRoot, 'game', 'tl', langDir),
      note: `Ren'Py 原生 tl/${langDir} 目录（引擎直接读取，无 hook 层）`,
    }
  },

  defaultRequirements(): RuntimeRequirement[] {
    return []
  },

  logPaths(gameRoot: string): string[] {
    return [join(gameRoot, 'log.txt'), join(gameRoot, 'game', 'log.txt')]
  },

  checks(gameRoot: string): RuntimeCheck[] {
    const logs = readLogs(renpyRuntime.logPaths(gameRoot))
    const hasLog = hasLogEvidence(renpyRuntime.logPaths(gameRoot))
    const out: RuntimeCheck[] = []

    out.push({
      id: 'renpy.loaded',
      title: 'Ren\'Py 运行日志证据',
      level: hasLog ? 'info' : 'info',
      ok: hasLog,
      detail: hasLog
        ? '存在运行日志（可作加载证据基础，仍需实机确认译文显示）。'
        : '无运行日志证据（未启动游戏或日志不在此路径），运行时未验证。',
    })

    const fontErr = /font|Font|ttf|otf|Invalid.*glyph|Glyph/i.test(logs)
    out.push({
      id: 'renpy.font',
      title: '字体加载提示',
      level: fontErr ? 'warn' : 'info',
      ok: !fontErr,
      detail: fontErr
        ? '日志出现字体相关错误，可能出现方框/乱码，需实机确认。'
        : '未在日志发现明显字体错误（仍需实机确认中文字体显示）。',
    })

    const traceback = existsSync(join(gameRoot, 'traceback.txt')) || existsSync(join(gameRoot, 'game', 'traceback.txt'))
    out.push({
      id: 'renpy.traceback',
      title: 'Ren\'Py 崩溃/回退检查',
      level: traceback ? 'warn' : 'info',
      ok: !traceback,
      detail: traceback
        ? '游戏目录存在 traceback.txt，可能有脚本错误导致译文块不加载，建议先查看。'
        : '未发现 traceback.txt。',
    })

    return out
  },
}
