import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { Config } from '../config'
import { resultToTool, runTav2 } from '../core/tav2'
import type { Tav2ToolResult } from '../core/types'
import { evaluateCandidates, type DeliberationStats, type EvidenceProvider, type SearchResult } from '../engine/deliberation'
import { openKnowledge, tsGenerate, tsKnowledgeResult } from './tsKnowledge'
import { deliberateMeta } from '../present/meta'

/** tav2_deliberate 的结构化结果（前端阶段 A）。 */
export interface Tav2DeliberateResult extends Tav2ToolResult {
  deliberation?: DeliberationStats
}

interface WebSearchSource {
  url?: unknown
  title?: unknown
  snippet?: unknown
  publishedAt?: unknown
}

interface WebSearchValue {
  content?: unknown
  sources?: unknown
  truncated?: unknown
}

/** 把 dsh tool-web 的 web_search 输出映射为引擎查证证据（缺字段降级为空串）。 */
function toSearchResults(value: WebSearchValue): SearchResult[] {
  if (!value || !Array.isArray(value.sources)) return []
  const out: SearchResult[] = []
  for (const raw of value.sources) {
    if (!raw || typeof raw !== 'object') continue
    const source = raw as WebSearchSource
    const url = String(source.url ?? '').trim()
    if (!url) continue
    out.push({
      url,
      title: String(source.title ?? ''),
      snippet: String(source.snippet ?? ''),
    })
  }
  return out
}

/** 基于 dsh tool-web 的查证 Provider；未注册/调用失败/结构异常时静默返回 []。 */
export function webSearchEvidence(
  ctx: Context,
  exec: ToolRunContext,
  maxResults: number,
): EvidenceProvider {
  return webSearchEvidenceFor({ enabled: true, engine: 'default', maxResults }, ctx, exec)
}

/** 按引擎 search 配置决定是否访问 tool-web；关闭/off 时完全不调用。 */
export function webSearchEvidenceFor(
  search: { enabled: boolean; engine: string; maxResults: number },
  ctx: Context,
  exec: ToolRunContext,
): EvidenceProvider {
  const limit = Math.max(1, Math.floor(search.maxResults || 0))
  return async (query: string): Promise<SearchResult[]> => {
    if (!search.enabled || search.engine === 'off') return []
    if (!ctx.tools.get('web_search')) return []
    try {
      const result = await ctx.tools.execute({
        callId: CallId(`tav2-web-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        rootCallId: exec.rootCallId,
        name: 'web_search',
        arguments: { query },
        parent: exec.token,
        agent: exec.agent,
        signal: exec.signal,
      })
      return toSearchResults(result.value as WebSearchValue).slice(0, limit)
    } catch {
      return []
    }
  }
}

/** engineBackend=ts：直接跑 TS 术语推敲（查证经 dsh tool-web 注入）。 */
async function runTsDeliberate(
  ctx: Context,
  config: Config,
  exec: ToolRunContext,
): Promise<Tav2DeliberateResult> {
  const knowledge = openKnowledge(config)
  try {
    const stats = await evaluateCandidates(
      await tsGenerate(ctx, config, knowledge.engineCfg),
      knowledge.db,
      knowledge.engineCfg,
      undefined,
      webSearchEvidenceFor(knowledge.engineCfg.search, ctx, exec),
    )
    return { ...tsKnowledgeResult(JSON.stringify(stats, null, 2)), deliberation: stats }
  } catch (err) {
    return tsKnowledgeResult(`术语推敲失败：${String(err instanceof Error ? err.message : err)}`, false)
  } finally {
    knowledge.db.close()
  }
}

export function registerDeliberateTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_deliberate',
    description: '对术语候选做多方位推敲（LLM 密集，可能较慢）；高置信自动锁定，其余入库待决。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          deliberation: {
            type: 'object',
            description: '结构化推敲统计（engineBackend=ts 时返回）',
            properties: {
              evaluated: { type: 'number' },
              auto_locked: { type: 'number' },
              pending_approval: { type: 'number' },
              failed: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2DeliberateResult) => {
        const head = value.ok ? '术语推敲完成' : '术语推敲失败'
        return [{ type: 'text', text: `${head}\n${value.text}` }]
      },
      presentationMeta: (_args, value) => deliberateMeta(_args, value),
    },
    async execute(_args, exec) {
      if (config.engineBackend !== 'python') return runTsDeliberate(ctx, config, exec)
      const result = await runTav2({ config, args: ['deliberate'], signal: exec.signal })
      return resultToTool(result)
    },
  }))
}
