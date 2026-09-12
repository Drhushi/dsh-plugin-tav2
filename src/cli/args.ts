/**
 * 极简 argv 解析（CLI 骨架用，不引外部依赖）：
 * 位置参数 + 长选项（--key value / --key=value）；booleanFlags 里的选项不吞下一个参数。
 */
export interface ParsedArgs {
  positionals: string[]
  /** --key → value；无值布尔选项值为 true。重复出现的 key 取最后一个。 */
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[], booleanFlags: readonly string[] = []): ParsedArgs {
  const boolSet = new Set(booleanFlags)
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
      } else if (boolSet.has(body)) {
        flags[body] = true
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next
          i++
        } else {
          flags[body] = true
        }
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}
