/**
 * /tav2-panel 命令：翻译工作台交互入口。
 *
 * 面板按钮 → inputActions 注入斜杠命令并提交 → 本命令 handler 确定性执行对应
 * tav2_* 工具（ctx.tools.execute），写操作（世界书/推敲定论）审批由工具自带，
 * 结果文本渲染成命令结果落会话日志。
 *
 * 纯逻辑（parsePanelCommand / panelActionToTool / renderToolContent）可离线单测；
 * 执行路径依赖宿主 tools/commands 服务，实机验证（doublecheck-spec 验收 4）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { CallId } from '@deepseek-ai/dsh-llm'

/** 面板命令解析出的结构化动作。 */
export type PanelAction =
  | { kind: 'project-switch'; dir: string }
  | { kind: 'worldbook-confirm'; ids: number[] }
  | { kind: 'worldbook-delete'; ids: number[] }
  | { kind: 'worldbook-add'; wbKind: string; title: string; content?: string; keywords?: string[]; linkedTerm?: string; sourceRefs?: string[] }
  | { kind: 'worldbook-edit'; id: number; title?: string; content?: string; keywords?: string[]; linkedTerm?: string; sourceRefs?: string[] }
  | { kind: 'deliberate-approve'; ids: number[] }
  | { kind: 'deliberate-reject'; ids: number[] }
  | { kind: 'deliberate-update'; id: number; target: string }
  | { kind: 'task-prepare' }
  | { kind: 'task-translate' }
  | { kind: 'task-backfill' }

export type ParsePanelResult = { ok: true; action: PanelAction } | { ok: false; error: string }

/** 解析逗号/空格分隔的 id 列表（正整数）。 */
function parseIdList(input: string): number[] | null {
  const parts = input.split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0) return null
  const ids: number[] = []
  for (const part of parts) {
    if (!/^[1-9]\d*$/.test(part)) return null
    ids.push(Number(part))
  }
  return ids
}

/**
 * 解析 /tav2-panel 原始输入。
 * 语法：
 *   project switch <dir>
 *   worldbook confirm|delete <ids>
 *   worldbook add <wbKind> <title> [--keywords a,b] [--linkedTerm X] [--sourceRefs a,b] [--content <剩余全部>]
 *   deliberate approve|reject <ids>
 *   deliberate update <id> <target>
 *   task prepare|translate|backfill
 * 注意：--content 必须是最后一个选项（吃掉其后全部文本）。
 */
export function parsePanelCommand(rawInput: string): ParsePanelResult {
  const input = (rawInput ?? '').trim()
  if (!input) return { ok: false, error: '空命令。用法见 /tav2-panel 描述。' }
  let tokens = input.split(/\s+/)
  // 兼容完整命令串（含命令名前缀，如面板按钮构造的「/tav2-panel …」）；
  // 宿主传入的 rawInput 本不含前缀，剥离是无害的防御。
  if (tokens[0] === '/tav2-panel' || tokens[0] === 'tav2-panel') tokens = tokens.slice(1)
  if (tokens.length === 0) return { ok: false, error: '空命令。用法见 /tav2-panel 描述。' }
  const sub = tokens[0]!.toLowerCase()

  if (sub === 'project') {
    if (tokens[1]?.toLowerCase() !== 'switch') {
      return { ok: false, error: 'project 子命令只支持 switch <dir>' }
    }
    const dir = tokens.slice(2).join(' ').trim()
    if (!dir) return { ok: false, error: 'project switch 需要项目目录' }
    return { ok: true, action: { kind: 'project-switch', dir } }
  }

  if (sub === 'worldbook') {
    const action = tokens[1]?.toLowerCase()
    if (action === 'confirm' || action === 'delete') {
      const ids = parseIdList(tokens.slice(2).join(' '))
      if (!ids) return { ok: false, error: `worldbook ${action} 需要正整数 id 列表（如 5,6 7）` }
      return { ok: true, action: action === 'confirm' ? { kind: 'worldbook-confirm', ids } : { kind: 'worldbook-delete', ids } }
    }
    if (action === 'add') {
      const rest = tokens.slice(2)
      const wbKind = rest[0]
      if (!wbKind) return { ok: false, error: 'worldbook add 需要条目类别（name/term/setting/lore/constant）' }
      const optIdx = rest.findIndex((t) => t.startsWith('--'))
      const titleTokens = optIdx === -1 ? rest.slice(1) : rest.slice(1, optIdx)
      const title = titleTokens.join(' ').trim()
      if (!title) return { ok: false, error: 'worldbook add 需要标题（如「艾玛（Emma）」）' }
      const entry: Extract<PanelAction, { kind: 'worldbook-add' }> = { kind: 'worldbook-add', wbKind, title }
      if (optIdx !== -1) {
        for (let i = optIdx; i < rest.length; i += 1) {
          const opt = rest[i]
          if (opt === '--content') {
            entry.content = rest.slice(i + 1).join(' ').trim()
            break
          }
          if (opt === '--keywords') {
            const v = rest[i + 1]
            if (v) entry.keywords = v.split(',').map((s) => s.trim()).filter(Boolean)
            i += 1
          } else if (opt === '--linkedTerm') {
            const v = rest[i + 1]
            if (v) entry.linkedTerm = v
            i += 1
          } else if (opt === '--sourceRefs') {
            const v = rest[i + 1]
            if (v) entry.sourceRefs = v.split(',').map((s) => s.trim()).filter(Boolean)
            i += 1
          }
        }
      }
      return { ok: true, action: entry }
    }
    if (action === 'update') {
      const idToken = tokens[2]
      if (!idToken || !/^[1-9]\d*$/.test(idToken)) return { ok: false, error: 'worldbook update 需要正整数 id' }
      const id = Number(idToken)
      const rest = tokens.slice(3)
      if (rest.length === 0) return { ok: false, error: 'worldbook update 需要至少一个选项（--title/--content/--keywords/--linkedTerm/--sourceRefs）' }
      const entry: Extract<PanelAction, { kind: 'worldbook-edit' }> = { kind: 'worldbook-edit', id }
      for (let i = 0; i < rest.length; i += 1) {
        const opt = rest[i]
        if (opt === '--title') {
          const v = rest[i + 1]
          if (v) entry.title = v
          i += 1
        } else if (opt === '--content') {
          // --content 必须收尾：吃掉其后全部文本（含空格），与 add 约定一致。
          const v = rest.slice(i + 1).join(' ').trim()
          if (v) entry.content = v
          break
        } else if (opt === '--keywords') {
          const v = rest[i + 1]
          if (v) entry.keywords = v.split(',').map((s) => s.trim()).filter(Boolean)
          i += 1
        } else if (opt === '--linkedTerm') {
          const v = rest[i + 1]
          if (v) entry.linkedTerm = v
          i += 1
        } else if (opt === '--sourceRefs') {
          const v = rest[i + 1]
          if (v) entry.sourceRefs = v.split(',').map((s) => s.trim()).filter(Boolean)
          i += 1
        }
      }
      return { ok: true, action: entry }
    }
    return { ok: false, error: 'worldbook 子命令只支持 confirm/delete/add/update' }
  }

  if (sub === 'deliberate') {
    const action = tokens[1]?.toLowerCase()
    if (action === 'approve' || action === 'reject') {
      const ids = parseIdList(tokens.slice(2).join(' '))
      if (!ids) return { ok: false, error: `deliberate ${action} 需要正整数 id 列表` }
      return { ok: true, action: action === 'approve' ? { kind: 'deliberate-approve', ids } : { kind: 'deliberate-reject', ids } }
    }
    if (action === 'update') {
      const idToken = tokens[2]
      if (!idToken || !/^[1-9]\d*$/.test(idToken)) return { ok: false, error: 'deliberate update 需要正整数 id' }
      const target = tokens.slice(3).join(' ').trim()
      if (!target) return { ok: false, error: 'deliberate update 需要新译名' }
      return { ok: true, action: { kind: 'deliberate-update', id: Number(idToken), target } }
    }
    return { ok: false, error: 'deliberate 子命令只支持 approve/reject/update' }
  }

  if (sub === 'task') {
    const action = tokens[1]?.toLowerCase()
    if (action === 'prepare') return { ok: true, action: { kind: 'task-prepare' } }
    if (action === 'translate') return { ok: true, action: { kind: 'task-translate' } }
    if (action === 'backfill') return { ok: true, action: { kind: 'task-backfill' } }
    return { ok: false, error: 'task 子命令只支持 prepare/translate/backfill' }
  }

  return { ok: false, error: `未知子命令：${sub}。支持 project/worldbook/deliberate/task。` }
}

/** 结构化动作 → 工具名 + 参数（全部动作都映射到既有 tav2_* 工具）。 */
export function panelActionToTool(action: PanelAction): { name: string; args: Record<string, unknown> } {
  switch (action.kind) {
    case 'project-switch':
      return { name: 'tav2_select_project', args: { project: action.dir } }
    case 'worldbook-confirm':
      return { name: 'tav2_worldbook_edit', args: { action: 'confirm', ids: action.ids } }
    case 'worldbook-delete':
      return { name: 'tav2_worldbook_edit', args: { action: 'delete', ids: action.ids } }
    case 'worldbook-add': {
      const args: Record<string, unknown> = { action: 'add', kind: action.wbKind, title: action.title }
      if (action.content) args.content = action.content
      if (action.keywords) args.keywords = action.keywords
      if (action.linkedTerm) args.linkedTerm = action.linkedTerm
      if (action.sourceRefs) args.sourceRefs = action.sourceRefs
      return { name: 'tav2_worldbook_edit', args }
    }
    case 'worldbook-edit': {
      const args: Record<string, unknown> = { action: 'update', id: action.id }
      if (action.title) args.title = action.title
      if (action.content) args.content = action.content
      if (action.keywords) args.keywords = action.keywords
      if (action.linkedTerm) args.linkedTerm = action.linkedTerm
      if (action.sourceRefs) args.sourceRefs = action.sourceRefs
      return { name: 'tav2_worldbook_edit', args }
    }
    case 'deliberate-approve':
      return { name: 'tav2_deliberate_confirm', args: { action: 'approve', ids: action.ids } }
    case 'deliberate-reject':
      return { name: 'tav2_deliberate_confirm', args: { action: 'reject', ids: action.ids } }
    case 'deliberate-update':
      return { name: 'tav2_deliberate_confirm', args: { action: 'update', id: action.id, target: action.target } }
    case 'task-prepare':
      return { name: 'tav2_prepare', args: {} }
    case 'task-translate':
      return { name: 'tav2_translate_batch', args: {} }
    case 'task-backfill':
      return { name: 'tav2_review_backfill', args: {} }
  }
}

/** 工具结果内容块 → 文本（text 块按行拼接；非 text 块 JSON 化）。 */
export function renderToolContent(content: readonly unknown[]): string {
  const lines: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) lines.push(text.trim())
    } else {
      try {
        const json = JSON.stringify(block)
        if (json) lines.push(json)
      } catch {
        // 忽略不可序列化内容。
      }
    }
  }
  return lines.join('\n').trim()
}

/** 命令执行结果（与宿主 CommandsLike 对齐的最小面）。 */
export type PanelCommandResult = { kind: 'success' | 'error'; text: string }

/** 最小 invocation 面（真实宿主传入完整 agent + signal）。 */
interface PanelCommandInvocation {
  agent: { id: unknown; ctx?: unknown } | null
  rawInput: string
  signal: AbortSignal
}

/**
 * 命令 handler：解析 → 映射工具 → ctx.tools.execute 执行 → 渲染结果。
 * 写工具内部请求审批（exec.agent 已传入完整 agent）；审批不可用/被拒由工具
 * fail-closed 返回失败文本，不静默。
 */
export async function handlePanelCommand(
  ctx: Context,
  invocation: PanelCommandInvocation,
): Promise<PanelCommandResult> {
  const parsed = parsePanelCommand(invocation.rawInput)
  if (!parsed.ok) return { kind: 'error', text: parsed.error }
  const mapped = panelActionToTool(parsed.action)
  try {
    const result = await ctx.tools.execute({
      callId: CallId(`tav2-panel:${randomUUID()}`),
      name: mapped.name,
      arguments: mapped.args,
      agent: invocation.agent as never,
      signal: invocation.signal,
    })
    const text = renderToolContent(result.content)
    return {
      kind: result.isError ? 'error' : 'success',
      text: text || (result.isError ? '命令执行失败（工具返回错误）' : '完成'),
    }
  } catch (err) {
    return { kind: 'error', text: `命令执行失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 注册 /tav2-panel 命令（commands 服务缺失时告警跳过，不阻塞插件）。 */
export function registerPanelCommand(ctx: Context): void {
  const commands = (ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') as
    | {
        register?: (definition: {
          name: string
          description: string
          input?: { hint: string }
          handler: (invocation: PanelCommandInvocation) => PanelCommandResult | Promise<PanelCommandResult>
        }) => unknown
      }
    | undefined
  if (!commands?.register) {
    console.warn('[dsh-plugin-tav2] commands 服务不可用，跳过 /tav2-panel 命令注册')
    return
  }
  try {
    commands.register({
      name: 'tav2-panel',
      description: '翻译工作台操作（面板按钮自动提交）：'
        + 'project switch <dir> | worldbook confirm|delete <ids> | worldbook add <类别> <标题> [--keywords a,b] [--linkedTerm X] [--content …] '
        + '| deliberate approve|reject <ids> | deliberate update <id> <新译名> | task prepare|translate|backfill',
      input: { hint: 'project switch <dir> | worldbook confirm <ids> | deliberate approve <ids> | task prepare' },
      handler: (invocation) => handlePanelCommand(ctx, invocation),
    })
  } catch (err) {
    console.warn('[dsh-plugin-tav2] /tav2-panel 命令注册失败：', err)
  }
}
