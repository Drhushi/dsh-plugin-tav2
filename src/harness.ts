/**
 * agent 作用域上下文的服务解析辅助。
 *
 * cordis 中 `ctx.skills`/`ctx.jobs`/`ctx.approval`/`ctx.llm` 等服务属性在
 * agent.ctx（dsh-scope）上必须 inject 才能直接访问，否则抛
 * `cannot get property "X" without inject`；而 `ctx.get(name)` 明确
 * 不要求 inject（直接读服务 store，scope 链上可达的宿主服务都能取到）。
 * 这里给 agent/child 作用域上下文套一层代理：属性访问失败时回退到
 * `ctx.get()`，让按 agent 注册的 tav2 工具在注册和执行两条路径上都能
 * 解析到宿主服务。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件会用到的宿主服务名（属性访问回退名单）。 */
const SERVICE_PROPS = new Set([
  'tools',
  'skills',
  'systemPrompt',
  'jobs',
  'approval',
  'llm',
  'settings',
  'credentials',
  'commands',
  'agents',
  'subagents',
])

/** 包装作用域上下文：直接属性访问失败时用 ctx.get() 解析宿主服务。 */
export function serviceResolvingContext(ctx: Context): Context {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && SERVICE_PROPS.has(prop)) {
        try {
          const direct = Reflect.get(target, prop, receiver)
          if (direct !== undefined) return direct
        } catch {
          // 属性访问器在没有 inject 时抛错，回退到 get()
        }
        const viaGet = (target as unknown as { get?: (name: string) => unknown }).get?.(prop)
        if (viaGet !== undefined) return viaGet
        return undefined
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
