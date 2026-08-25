/**
 * 翻译风格解析（方案 A）：不默认——启动时询问一次；无确认通道降级 faithful（与现状一致）。
 * 架构约束：engine 层不依赖 dsh，因此询问只能发生在 tools 层（有 exec/ctx 与打开中的 turn）。
 * 询问结果按项目 DB 路径缓存在进程内（子代理分批复用同一选择，只问一次）；config 优先。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { approvalDenialText, requestApproval } from '../core/approval'
import type { EngineConfig } from '../engine/config'
import { resolveProjectDbPath } from '../engine/config'

export interface ResolvedStyle {
  preset: string
  prompt: string
  /** 来源：config=配置已设；asked=启动询问放行；fallback=无通道降级；rejected=用户拒绝/取消。 */
  source: 'config' | 'asked' | 'fallback' | 'rejected'
}

/** 启动时向用户确认风格的审批文案（含三档与自定义的指引）。 */
export const STYLE_ASK_REASON =
  '翻译风格未设置：本轮将按「忠实直译」（faithful）执行。'
  + '如需 自然通顺(standard)/文学化(literary)/自定义风格，请先在项目 config.yaml 设置'
  + ' translation.style_preset 或 style_prompt 后重跑。确认按 faithful 继续？'

// 进程内按项目 DB 记住本轮风格选择（启动询问一次；config 始终优先）。
const styleChoiceByDb = new Map<string, { preset: string; prompt: string }>()

/** 清空风格选择缓存（测试用）。 */
export function resetTranslationStyleCache(): void {
  styleChoiceByDb.clear()
}

/**
 * 解析本轮翻译风格：
 * - config 已设 → 直接用（不问）；
 * - 未设且 ts 后端 → 询问一次（放行/无通道 → faithful；拒绝/取消 → rejected）；
 * - python 后端不消费 TS 风格 → 不询问。
 */
export async function resolveTranslationStyle(
  ctx: Context,
  exec: ToolRunContext,
  config: { engineConfigPath: string; projectDir: string; engineBackend?: string },
  engineCfg: EngineConfig,
): Promise<ResolvedStyle> {
  const preset = (engineCfg.translation?.stylePreset ?? '').trim()
  const prompt = (engineCfg.translation?.stylePrompt ?? '').trim()
  if (preset || prompt) return { preset, prompt, source: 'config' }
  if (config.engineBackend === 'python') return { preset: '', prompt: '', source: 'config' }
  const dbPath = resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir)
  const cached = styleChoiceByDb.get(dbPath)
  if (cached) return { ...cached, source: 'asked' }
  const decision = await requestApproval(ctx, exec, STYLE_ASK_REASON)
  if (decision === 'allowed') {
    const choice = { preset: 'faithful', prompt: '' }
    styleChoiceByDb.set(dbPath, choice)
    return { ...choice, source: 'asked' }
  }
  if (decision === 'unavailable') {
    // 无确认通道：降级 faithful，与现状一致。
    const choice = { preset: 'faithful', prompt: '' }
    styleChoiceByDb.set(dbPath, choice)
    return { ...choice, source: 'fallback' }
  }
  return { preset: '', prompt: '', source: 'rejected' }
}

/** 拒绝/取消时的中止文案（指引用户设置风格后重试）。 */
export function styleDenialText(decision: 'rejected' | 'cancelled'): string {
  return `${approvalDenialText(decision)}；请先设置 translation.style_preset（faithful/standard/literary）或 style_prompt 后重试`
}
