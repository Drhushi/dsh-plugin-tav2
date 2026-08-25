/**
 * 会话翻译作用域注册跟踪（translation_scope 与 tav2_init 共享）。
 *
 * 背景：dsh-tools 同名工具在同一个 scope 重复注册会抛
 * 「tool "<name>" is already registered in this scope」。
 * 会话先装「轻量引导包」（slim：detect/init/select_project/status），
 * tav2_init 初始化成功后要升级为「全套」（full：slim ⊂ full）。
 * 这里按 agent 记录已注册的工具名/技能/作用域等级，升级时只补增量，
 * 避免重复注册抛错；agent/disposed 时由作用域安装方清理。
 */
export type ScopeKind = 'full' | 'slim'

const appliedKind = new Map<string, ScopeKind>()
const registeredTools = new Map<string, Set<string>>()
const registeredSkills = new Set<string>()

/** 记录某 agent 已注册的工具名。 */
export function markToolsRegistered(agentId: string, names: string[]): void {
  const set = registeredTools.get(agentId) ?? new Set<string>()
  for (const n of names) set.add(n)
  registeredTools.set(agentId, set)
}

/** 返回 names 中尚未注册的增量（供升级/幂等注册）。 */
export function missingToolNames(agentId: string, names: string[]): string[] {
  const set = registeredTools.get(agentId)
  if (!set) return [...names]
  return names.filter((n) => !set.has(n))
}

/** 当前会话作用域等级；未安装返回 undefined。 */
export function scopeKindOf(agentId: string): ScopeKind | undefined {
  return appliedKind.get(agentId)
}

/** 记录会话作用域等级（slim → full 允许升级覆盖）。 */
export function setScopeKind(agentId: string, kind: ScopeKind): void {
  appliedKind.set(agentId, kind)
}

/** 该 agent 是否已注册翻译工作流技能（避免重复注册同名技能）。 */
export function hasWorkflowSkill(agentId: string): boolean {
  return registeredSkills.has(agentId)
}

/** 记录该 agent 已注册翻译工作流技能。 */
export function markWorkflowSkill(agentId: string): void {
  registeredSkills.add(agentId)
}

/** 清理某 agent 的全部注册跟踪（agent/disposed 时调用，防 Map 泄漏）。 */
export function clearScopeTrack(agentId: string): void {
  appliedKind.delete(agentId)
  registeredTools.delete(agentId)
  registeredSkills.delete(agentId)
}

/** 测试/诊断：清空全部跟踪。 */
export function resetScopeTrack(): void {
  appliedKind.clear()
  registeredTools.clear()
  registeredSkills.clear()
}
