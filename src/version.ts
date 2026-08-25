/**
 * 插件自检标识：加载的版本 + 模块来源。
 * 用途：区分「运行进程实际加载的插件」与「磁盘上的仓库」——
 * harness 从安装副本（~/.dsh/profiles/web/node_modules/dsh-plugin-tav2）加载，
 * 改仓库代码后若未同步+重启，status 里的版本/来源会暴露这一点。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** 当前加载的插件版本（读自包根 package.json，dist 与 src 均指向同一份）。 */
export function pluginVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 插件模块加载来源目录（区分仓库 src / 安装副本 dist / 其他）。 */
export function pluginSource(): string {
  try {
    return fileURLToPath(new URL('..', import.meta.url))
  } catch {
    return ''
  }
}
