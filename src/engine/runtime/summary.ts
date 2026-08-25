/** 运行时汇总（verify/status 共用）：合并伴侣组件、读日志、汇总三层结论。 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineRuntime, RuntimeCheck, RuntimeRequirement } from '../adapters/types'

/** 项目配置里的运行时段（EngineConfig.runtime）。 */
export interface RuntimeConfig {
  logPaths: string[]
  requirements: { id: string; name: string; paths: string[]; doc?: string }[]
}

export interface RuntimeSummary {
  mode: { kind: string; translationDir: string | null; note: string } | null
  runtimeLayer: 'ok' | 'unverified' | 'warn' | 'fail'
  checks: RuntimeCheck[]
  requirements: RuntimeRequirement[]
}

/** 汇总运行时状态：mode + 合并需求 + 失效点检查 + 三层结论。 */
export function summarizeRuntime(
  rt: EngineRuntime,
  gameRoot: string,
  lang: string | undefined,
  configRuntime: RuntimeConfig,
): RuntimeSummary {
  const mode = rt.modeOf(gameRoot, lang)
  const configReqs: RuntimeRequirement[] = configRuntime.requirements.map((q) => ({
    id: q.id,
    name: q.name,
    paths: q.paths,
    doc: q.doc ?? '',
    installed: q.paths.every((p) => existsSync(join(gameRoot, p))),
  }))
  const reqMap = new Map<string, RuntimeRequirement>()
  for (const r of [...rt.defaultRequirements(gameRoot), ...configReqs]) {
    if (!reqMap.has(r.id)) reqMap.set(r.id, r)
  }
  const requirements = [...reqMap.values()]
  const logPaths = [...new Set([...rt.logPaths(gameRoot), ...configRuntime.logPaths])]
  const checks = rt.checks(gameRoot, { logPaths, requirements })

  const missingReqs = requirements.filter((r) => !r.installed)
  const hasError = checks.some((c) => c.level === 'error')
  const hasWarn = checks.some((c) => c.level === 'warn')
  const logEvidence = logPaths.some((p) => {
    try { return existsSync(p) && statSync(p).size > 0 } catch { return false }
  })

  let runtimeLayer: 'ok' | 'unverified' | 'warn' | 'fail'
  if (hasError) runtimeLayer = 'fail'
  else if (missingReqs.length > 0) runtimeLayer = 'warn'
  else if (!logEvidence) runtimeLayer = 'unverified'
  else if (hasWarn) runtimeLayer = 'warn'
  else runtimeLayer = 'ok'

  return { mode, runtimeLayer, checks, requirements }
}
