/**
 * 翻译工作台纯数据 helper（浏览器端，无 DOM / 无 React 依赖，可离线单测）：
 * - workspaceDirOf：会话 → 工作区目录解析；
 * - panelStateOf：/tav2/panel 路由 JSON → 归一化面板状态；
 * - nextStepOf / activeRunOf / formatTime：状态带引导行、运行状态、时间展示。
 * 对应 tests/client-workspace-panel.test.ts。
 */

/** 从 useWorkspaces.items 解析当前会话工作区目录；找不到返回 ''。 */
export function workspaceDirOf(sessionId, items) {
  if (Array.isArray(items)) {
    const hit = items.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId))
    if (hit && typeof hit.path === 'string' && hit.path !== '') return hit.path
  }
  return ''
}

/** 归一化 /tav2/panel 路由 JSON → 面板状态（kind: ok/no-project/not-initialized/multiple-projects/error）。 */
export function panelStateOf(json) {
  if (json == null || typeof json !== 'object') return { kind: 'error', message: '响应格式异常' }
  if (json.ok === true && json.panel && typeof json.panel === 'object') {
    return {
      kind: 'ok',
      panel: json.panel,
      project: json.project && typeof json.project === 'object' ? json.project : undefined,
      projects: Array.isArray(json.projects) ? json.projects : undefined,
    }
  }
  const code = json.code
  if (code === 'no-project' || code === 'not-initialized') {
    return { kind: code, message: json.message || '' }
  }
  if (code === 'multiple-projects') {
    return {
      kind: 'multiple-projects',
      message: json.message || '',
      candidates: Array.isArray(json.candidates) ? json.candidates : [],
    }
  }
  return { kind: 'error', message: json.message || '未知错误' }
}

/** 卡片注册表槽位（未来功能按名装即可扩展）。任务动态（process）紧随状态带，让运行动态第一时间可见。 */
export function extensionSlotsOf() {
  return ['overview', 'process', 'worldbook', 'progress', 'extras']
}

/** 世界书排序：proposed 置顶，其余原次序（稳定）。 */
export function sortWorldbookProposedFirst(list) {
  if (!Array.isArray(list)) return []
  const cloned = list.slice()
  cloned.sort((a, b) => {
    const aPro = a && a.status === 'proposed' ? 0 : 1
    const bPro = b && b.status === 'proposed' ? 0 : 1
    if (aPro !== bPro) return aPro - bPro
    return 0
  })
  return cloned
}

// ---------- 交互命令串（与 src/tools/panel_commands.ts 的语法一一对应） ----------

/** id 列表 → CSV（过滤非正整数）。 */
export function idsCsv(ids) {
  return (Array.isArray(ids) ? ids : [])
    .filter((n) => Number.isInteger(n) && n > 0)
    .join(',')
}

/** project switch 命令。 */
export function projectSwitchCommand(dir) {
  return `/tav2-panel project switch ${String(dir ?? '').trim()}`
}

/** 世界书确认命令。 */
export function worldbookConfirmCommand(ids) {
  return `/tav2-panel worldbook confirm ${idsCsv(ids)}`
}

/** 世界书更新命令（update 语法：--oct 必须最后一个，与解析器约定一致）。 */
export function worldbookDeleteCommand(ids) {
  return `/tav2-panel worldbook delete ${idsCsv(ids)}`
}

/** 世界书编辑命令（--content 必须收尾，与解析器约定一致）。 */
export function worldbookEditCommand(entry) {
  const e = entry ?? {}
  const id = Number(e.id)
  if (!Number.isInteger(id) || id <= 0) return ''
  const parts = [`/tav2-panel worldbook update ${id}`]
  if (e.title) parts.push(`--title ${String(e.title).trim()}`)
  if (Array.isArray(e.keywords) && e.keywords.length > 0) parts.push(`--keywords ${e.keywords.join(',')}`)
  if (e.linkedTerm) parts.push(`--linkedTerm ${e.linkedTerm}`)
  if (Array.isArray(e.sourceRefs) && e.sourceRefs.length > 0) parts.push(`--sourceRefs ${e.sourceRefs.join(',')}`)
  if (e.content) parts.push(`--content ${String(e.content)}`)
  return parts.join(' ')
}

/** 推敲定论批准命令。 */
export function deliberateApproveCommand(ids) {
  return `/tav2-panel deliberate approve ${idsCsv(ids)}`
}

/** 推敲定论拒绝命令。 */
export function deliberateRejectCommand(ids) {
  return `/tav2-panel deliberate reject ${idsCsv(ids)}`
}

/**
 * 下一步引导（状态带唯一行动建议，替代成排任务按钮）：
 * 按翻译流水线优先级返回一个建议动作。
 * - 面板内可完成的（世界书确认）→ jump：滚到对应卡片就地处理；
 * - 需要助手执行的 → phrase：把自然话术填进输入框（只填不提交，由用户确认发送）。
 * 推敲审批不再进本引导：它直接渲染在状态带下一步行下方，已可见即无需引导。
 * 无建议时返回 null（全部完成且无待办）。
 */
export function nextStepOf(panel) {
  const safe = panel && typeof panel === 'object' ? panel : {}
  const progress = safe.progress && typeof safe.progress === 'object' ? safe.progress : null
  // 没有进度数据（面板异常/未就绪）不做任何任务建议，避免误导。
  if (!progress || !Number.isFinite(Number(progress.units))) return null
  const units = Math.max(0, Number(progress.units))
  const translated = Math.max(0, Number(progress.translated) || 0)
  const pending = Math.max(0, Number(progress.pending) || 0)
  const missing = Math.max(0, Number(progress.missing) || 0)
  const worldbookPending = Math.max(0, Number(safe.worldbookPending) || 0)
  // 审批类最先：术语/译名定论影响后续翻译质量，先清待办再开任务。
  if (worldbookPending > 0) {
    return { key: 'worldbook', title: `确认 ${worldbookPending} 条世界书待确认条目`, action: { type: 'jump', target: 'tv2p-worldbook' } }
  }
  if (units === 0) {
    return { key: 'prepare', title: '准备翻译模板', action: { type: 'phrase', phrase: '准备翻译模板' } }
  }
  if (pending > 0) {
    return { key: 'translate', title: `开始翻译（待译 ${pending} 条）`, action: { type: 'phrase', phrase: '开始翻译' } }
  }
  if (missing > 0) {
    // flagged 单元的重试路径就是重跑翻译（选取按 tl 是否有译文），不存在独立的「人审回填」。
    return { key: 'retry', title: `重跑翻译重试 ${missing} 条失败单元`, action: { type: 'phrase', phrase: '开始翻译' } }
  }
  if (translated >= units && units > 0) {
    return { key: 'pack', title: '全部已译，可打包交付', action: { type: 'phrase', phrase: '打包翻译补丁' } }
  }
  return null
}

/** 是否有进行中的 run（runs.status：running/done/error）；有则状态带显示呼吸点。 */
export function activeRunOf(panel) {
  const runs = panel && Array.isArray(panel.runs) ? panel.runs : []
  return runs.find((r) => {
    const status = String(r && r.status ? r.status : '').toLowerCase()
    return status === 'running' || status === 'stopping'
  }) ?? null
}

/** ISO 时间串 → 本地「MM-DD HH:mm」；解析失败原样返回，空值返回空串。 */
export function formatTime(value) {
  if (typeof value !== 'string' || value === '') return ''
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return value
  const d = new Date(ts)
  const two = (n) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * 项目候选按钮标签：取路径末段；与其他候选重名时补一级父目录消歧。
 * 例：两个「work/<game>」候选同名为 game1 →「work / game1」。
 */
export function projectLabelOf(dir, allDirs) {
  const parts = String(dir ?? '').split(/[\\/]/).filter(Boolean)
  const name = parts.pop() ?? String(dir ?? '')
  const dup = (Array.isArray(allDirs) ? allDirs : []).some(
    (d) => d !== dir && String(d ?? '').split(/[\\/]/).filter(Boolean).pop() === name,
  )
  if (dup && parts.length > 0) return `${parts.pop()} / ${name}`
  return name
}

// ---------- 任务动态：实时活动流 / 摘要可读化 ----------

/** LLM 调用 stage → 中文标签（recording 快照的 stage 字段）。 */
export function stageLabelOf(stage) {
  const map = {
    understand: '理解场景',
    translate: '翻译',
    summary: '剧情小结',
    polish: '润色',
  }
  return map[String(stage ?? '')] || String(stage ?? '') || '调用'
}

/** 秒数 → 「mm:ss」（超 1 小时 h:mm:ss）；脏输入归 0。 */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * 实时活动流统计（尾部快照窗口内）：调用数 / 累计 tokens / 涉及场景数 / 错误数 / 最近一条。
 * 注意 tokens 与场景数都是「窗口内」口径，随尾部窗口滑动，非全程累计。
 */
export function liveStatsOf(prompts) {
  const list = Array.isArray(prompts) ? prompts : []
  const scenes = new Set()
  let tokens = 0
  let errors = 0
  for (const p of list) {
    if (p && typeof p.sceneId === 'string' && p.sceneId) scenes.add(p.sceneId)
    tokens += (Number(p && p.promptTokens) || 0) + (Number(p && p.completionTokens) || 0)
    if (p && p.error) errors += 1
  }
  return { calls: list.length, tokens, scenes: scenes.size, errors, last: list.length > 0 ? list[list.length - 1] : null }
}

/**
 * run.summary（结束时的 stats JSON 串）→ 可读一行：「单元 12/40 · 场景 2/5 · tokens 150 · 失败 1」。
 * 非 JSON 串原样返回（超 80 字截断）；空值返回空串。
 */
export function runSummaryOf(summary) {
  if (typeof summary !== 'string' || summary.trim() === '') return ''
  let s
  try {
    s = JSON.parse(summary)
  } catch {
    return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary
  }
  if (s == null || typeof s !== 'object') return ''
  const parts = []
  if (s.units_total !== undefined) parts.push(`单元 ${s.units_translated ?? 0}/${s.units_total}`)
  if (s.scenes_total !== undefined) parts.push(`场景 ${s.scenes_done ?? 0}/${s.scenes_total}`)
  const tokens = (Number(s.usage?.prompt_tokens) || 0) + (Number(s.usage?.completion_tokens) || 0)
  if (tokens > 0) parts.push(`tokens ${tokens.toLocaleString()}`)
  if (s.flagged_units) parts.push(`失败 ${s.flagged_units}`)
  if (s.retry_rounds) parts.push(`重试 ${s.retry_rounds} 轮`)
  return parts.join(' · ')
}

/** 人工补世界书命令（--content 必须收尾，与解析器约定一致）。 */
export function worldbookAddCommand(entry) {
  const e = entry ?? {}
  const parts = [`/tav2-panel worldbook add ${String(e.wbKind ?? '').trim()}`, String(e.title ?? '').trim()]
  if (Array.isArray(e.keywords) && e.keywords.length > 0) parts.push(`--keywords ${e.keywords.join(',')}`)
  if (e.linkedTerm) parts.push(`--linkedTerm ${e.linkedTerm}`)
  if (Array.isArray(e.sourceRefs) && e.sourceRefs.length > 0) parts.push(`--sourceRefs ${e.sourceRefs.join(',')}`)
  if (e.content) parts.push(`--content ${e.content}`)
  return parts.join(' ')
}

// ---------- 进度明细：单场景单元明细（懒加载） ----------

/** /tav2/panel/scene-units 懒加载 URL（进度明细点开场景行时用）。 */
export function sceneUnitsUrlOf(dir, sessionId, sceneId) {
  return `/tav2/panel/scene-units?dir=${encodeURIComponent(String(dir ?? ''))}`
    + `&session=${encodeURIComponent(String(sessionId ?? ''))}`
    + `&sceneId=${encodeURIComponent(String(sceneId ?? ''))}`
}

/** 单元状态 → 语义色 tone（translated=ok、flagged=danger、removed=muted，其余默认）。 */
export function unitStatusTone(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'translated') return 'ok'
  if (s === 'flagged') return 'danger'
  if (s === 'removed') return 'muted'
  return null
}

/** 单元状态 → 中文徽标（未知状态原样展示）。 */
export function unitStatusLabel(status) {
  const map = { translated: '已译', pending: '待译', flagged: '失败', removed: '已删' }
  const s = String(status ?? '')
  return map[s] || s || '未知'
}
