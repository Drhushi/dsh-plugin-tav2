/**
 * 翻译工作台「翻译」标签页（conversation.view，id=tav2.workspace）。
 *
 * 重设计：待办驱动布局 + 语义色 + 按钮减法 + 图标化 + 数据缓存轮询。
 *   StatusBand（项目切换器 + 覆盖率语义色 + 「下一步」唯一引导 + 推敲审批原地处理 + 运行呼吸点）
 *   ProcessCard「任务动态」（紧随状态带：实时活动区看 AI 在干嘛；失败单元明细 / flags / 用量 / 运行历史）
 *   WorldbookCard（可折叠；条目行只留标题+徽标，编辑/删除收进展开区，删除两段式确认；批量确认置顶）
 *   ProgressCard（可折叠；全场景滚动列表，场景行点开展开单元明细——源/译文/状态按场景懒加载）
 * 任务发起不再提供按钮（对助手说一句话即可，避免正式环境功能不可用时的困惑）；
 * 「下一步」引导行按流水线优先级给出唯一建议：面板内动作跳转待办区，聊天动作只填话术不提交。
 * 数据流：模块级缓存（会话|项目 keyed，切回标签页不重新加载）+ SWR 后台刷新
 * + 运行中 5s 轮询 + 写操作后「变化即停」轮询。
 * 交互按钮注入 /tav2-panel 命令并自动提交（写操作审批由服务端工具处理）。
 * 纯 helper（workspaceDirOf / panelStateOf / nextStepOf / activeRunOf /
 * formatTime / projectLabelOf / stageLabelOf / formatDuration / liveStatsOf / runSummaryOf /
 * extensionSlotsOf / sortWorldbookProposedFirst / 命令串构造）可离线单测
 * （tests/client-workspace-panel.test.ts）。
 */
import React from 'react'
import {
  deliberateApproveCommand,
  deliberateRejectCommand,
  activeRunOf,
  extensionSlotsOf,
  formatDuration,
  formatTime,
  liveStatsOf,
  nextStepOf,
  panelStateOf,
  projectLabelOf,
  projectSwitchCommand,
  runSummaryOf,
  sceneUnitsUrlOf,
  sortWorldbookProposedFirst,
  stageLabelOf,
  unitStatusLabel,
  unitStatusTone,
  worldbookAddCommand,
  worldbookConfirmCommand,
  worldbookDeleteCommand,
  worldbookEditCommand,
  workspaceDirOf,
} from './workspacePanelData.js'

// ---------- 样式（语义色 token + 宿主主题变量，亮/暗色跟随） ----------

const PANEL_CSS = `
.tv2p{
  --tv2p-ok:var(--dsw-alias-label-success,#1a7f37);
  --tv2p-warn:var(--dsw-alias-label-warning,#9a6700);
  --tv2p-danger:var(--dsw-alias-label-error,#d1242f);
  --tv2p-info:var(--dsw-alias-brand-primary,#0969da);
  --tv2p-border:var(--dsw-alias-border-l2,rgba(127,127,127,.35));
  --tv2p-border-soft:var(--dsw-alias-border-l2,rgba(127,127,127,.15));
  --tv2p-muted:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));
  --tv2p-surface:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));
  margin:12px 16px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)
}
.tv2p-hint{color:var(--tv2p-muted);font-size:12px;line-height:1.6;margin:0}
.tv2p-section{border:1px solid var(--tv2p-border);border-radius:10px;padding:10px 12px;margin:0 0 10px}
.tv2p-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin-bottom:8px}
.tv2p-head--click{cursor:pointer;user-select:none;margin-bottom:0}
.tv2p-headTitle{flex:1;display:flex;gap:8px;align-items:center;min-width:0}
.tv2p-badge{white-space:nowrap;background:var(--tv2p-surface);color:var(--dsw-alias-label-secondary,var(--tv2p-muted));border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:1.6}
.tv2p-badge--ok{color:var(--tv2p-ok);background:color-mix(in srgb,var(--tv2p-ok) 10%,transparent)}
.tv2p-badge--warn{color:var(--tv2p-warn);background:color-mix(in srgb,var(--tv2p-warn) 10%,transparent)}
.tv2p-badge--danger{color:var(--tv2p-danger);background:color-mix(in srgb,var(--tv2p-danger) 10%,transparent)}
.tv2p-badge--muted{color:var(--tv2p-muted);background:transparent}
.tv2p-row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.tv2p-cell .tv2p-label{color:var(--tv2p-muted);font-size:11px}
.tv2p-cell .tv2p-value{font-size:15px;font-weight:600}
.tv2p-bar{height:6px;border-radius:3px;background:var(--tv2p-surface);overflow:hidden;flex:1 1 120px;min-width:80px}
.tv2p-barfill{height:100%;background:var(--tv2p-ok);transition:width .3s ease}
.tv2p-item{border-top:1px solid var(--tv2p-border-soft);padding:6px 0;font-size:12px;line-height:1.5}
.tv2p-itemTitle{font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tv2p-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--tv2p-muted)}
.tv2p-actions{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}
.tv2p-btn{font:inherit;cursor:pointer;border:1px solid var(--tv2p-border);background:transparent;color:var(--dsw-alias-label-secondary,var(--tv2p-muted));border-radius:8px;padding:4px 12px;font-size:12px;transition:color .15s,border-color .15s,background .15s}
.tv2p-btn:hover{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-dimmed,var(--tv2p-border))}
.tv2p-btn:disabled{opacity:.45;cursor:not-allowed}
.tv2p-btn--danger{color:var(--tv2p-danger);border-color:color-mix(in srgb,var(--tv2p-danger) 45%,transparent)}
.tv2p-btn--danger:hover{color:var(--tv2p-danger);border-color:var(--tv2p-danger)}
.tv2p-input{font:inherit;border:1px solid var(--tv2p-border);background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:5px 10px;font-size:12px;min-width:0}
.tv2p-input::placeholder{color:var(--tv2p-muted)}
.tv2p-err{color:var(--tv2p-danger);font-size:12px;line-height:1.6;margin:0}
.tv2p-exp-body{padding:8px;border-top:1px solid var(--tv2p-border-soft)}
.tv2p-monopre{font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;background:var(--tv2p-surface);padding:6px;border-radius:6px;max-height:200px;overflow:auto;margin:4px 0}
.tv2p-edit-row{display:flex;gap:8px;margin:4px 0;align-items:center;flex-wrap:wrap}
.tv2p-edit-row .tv2p-input{flex:1;min-width:120px}
.tv2p-slot{display:none}
/* 图标按钮（title + aria-label 提供可访问名）。 */
.tv2p-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--tv2p-muted);cursor:pointer;flex:none;transition:color .15s,background .15s}
.tv2p-iconbtn:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--tv2p-surface)}
.tv2p-iconbtn--danger:hover{color:var(--tv2p-danger)}
.tv2p-iconbtn:disabled{opacity:.45;cursor:not-allowed}
.tv2p-chev{transition:transform .15s ease;color:var(--tv2p-muted);flex:none}
.tv2p-chev--open{transform:rotate(90deg)}
/* 运行中呼吸点。 */
@keyframes tv2p-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.tv2p-dot{width:8px;height:8px;border-radius:50%;background:var(--tv2p-info);animation:tv2p-pulse 1.6s ease-in-out infinite;flex:none}
/* 下一步引导行。 */
.tv2p-next{display:flex;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--tv2p-border-soft);font-size:12px}
.tv2p-nextLabel{color:var(--tv2p-info);font-weight:600;flex:none}
.tv2p-nextTitle{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,inherit)}
/* 项目切换下拉。 */
.tv2p-menu{position:absolute;top:100%;left:0;z-index:20;min-width:160px;max-height:240px;overflow:auto;margin-top:4px;padding:4px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--tv2p-border);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.14)}
.tv2p-menuItem{justify-content:flex-start;text-align:left;border-color:transparent}
/* 可点卡片头 / 条目行：hover 高亮 + 键盘焦点环。 */
.tv2p-head--click{padding:4px 6px;margin:-4px -6px;border-radius:8px}
.tv2p-head--click:hover{background:var(--tv2p-surface)}
.tv2p-rowclick{border-radius:8px}
.tv2p-rowclick:hover{background:var(--tv2p-surface)}
.tv2p-head--click:focus-visible,.tv2p-rowclick:focus-visible{outline:2px solid var(--tv2p-info);outline-offset:-2px}
.tv2p-btn:focus-visible,.tv2p-iconbtn:focus-visible{outline:2px solid var(--tv2p-info);outline-offset:1px}
/* 达成态数值着语义色。 */
.tv2p-value--ok{color:var(--tv2p-ok)}
/* 实时活动流。 */
.tv2p-live{margin-top:8px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--tv2p-info) 30%,var(--tv2p-border-soft));border-radius:8px;background:color-mix(in srgb,var(--tv2p-info) 4%,transparent)}
.tv2p-liveHead{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600}
.tv2p-liveNow{flex:1;min-width:0;font-weight:500}
.tv2p-feed{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;font-size:11px;line-height:1.7}
.tv2p-feedRow{display:flex;gap:8px;align-items:baseline;min-width:0}
.tv2p-feedStage{flex:none;color:var(--dsw-alias-label-secondary,var(--tv2p-muted))}
.tv2p-feedScene{flex:1;min-width:0;color:var(--tv2p-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tv2p-feedMeta{flex:none;font-family:ui-monospace,Consolas,monospace;color:var(--tv2p-muted)}
.tv2p-feedRow--err .tv2p-feedStage,.tv2p-feedRow--err .tv2p-feedScene{color:var(--tv2p-danger)}
.tv2p-liveSub{margin:6px 0 0;color:var(--tv2p-muted);font-size:11px}
/* 进度明细点开后的单元列表：滚动容器 + 源/译两行。 */
.tv2p-units{display:flex;flex-direction:column;gap:8px;margin-top:8px;max-height:260px;overflow:auto;padding-right:2px}
/* 进度明细全场景列表：容器内滚动，所有场景都可达。 */
.tv2p-scenes{display:flex;flex-direction:column;margin-top:8px;max-height:320px;overflow:auto;padding-right:2px}
.tv2p-unitSrc{color:var(--dsw-alias-label-secondary,inherit);line-height:1.5;white-space:pre-wrap;word-break:break-word}
.tv2p-unitTl{color:var(--tv2p-muted);line-height:1.5;white-space:pre-wrap;word-break:break-word}
`
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-plugin-tav2/panel"]') === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-tav2'
  tag.dataset.pluginCss = 'dsh-plugin-tav2/panel'
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

function h(type, props, ...children) {
  return React.createElement(type, props ?? null, ...children)
}

// ---------- 图标（内联 SVG，currentColor 跟随文字色，无外部依赖） ----------

const ICON_PATHS = {
  chevron: 'M9 18l6-6-6-6',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z',
  check: 'M20 6L9 17l-5-5',
  refresh: 'M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10',
}

/** 内联 SVG 图标（装饰性：aria-hidden，可访问名由按钮 title/aria-label 提供）。 */
function Icon({ name, size = 14 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, h('path', { d: ICON_PATHS[name] ?? '' }))
}

/** 图标按钮：必须给 title + aria-label（无文字，可访问性靠它）。 */
function IconButton({ icon, title, danger, onClick, disabled }) {
  return h('button', {
    type: 'button',
    className: 'tv2p-iconbtn' + (danger ? ' tv2p-iconbtn--danger' : ''),
    title,
    'aria-label': title,
    onClick,
    disabled: disabled === true,
  }, h(Icon, { name: icon }))
}

/** 可展开箭头（Section / 条目行共用）。 */
function Chevron({ open }) {
  return h('span', { className: 'tv2p-chev' + (open ? ' tv2p-chev--open' : ''), style: { display: 'inline-flex' } },
    h(Icon, { name: 'chevron' }))
}

// ---------- 卡片壳（可折叠分区：头整体可点 + chevron，无文字展开按钮） ----------

function Section({ id, title, badge, defaultOpen = false, collapsible = true, children }) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen))
  const toggle = () => setOpen(!open)
  const onHeadKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }
  return h('div', { className: 'tv2p-section', id },
    h('div', {
      className: 'tv2p-head' + (collapsible ? ' tv2p-head--click' : ''),
      onClick: collapsible ? toggle : undefined,
      onKeyDown: collapsible ? onHeadKeyDown : undefined,
      tabIndex: collapsible ? 0 : undefined,
      role: collapsible ? 'button' : undefined,
      'aria-expanded': collapsible ? open : undefined,
    },
      h('span', { className: 'tv2p-headTitle' },
        h('span', null, title),
        badge ?? null,
      ),
      collapsible ? h(Chevron, { open }) : null,
    ),
    (!collapsible || open) ? h('div', { style: { marginTop: 8 } }, children) : null,
  )
}

const WORLDBOOK_STATUS_TONE = { confirmed: 'ok', proposed: 'warn', rejected: 'muted' }
const WORLDBOOK_STATUS_LABEL = { confirmed: '已确认', proposed: '待确认', rejected: '已拒绝' }

/** 徽标（可选语义色 tone：ok/warn/danger/muted）。 */
function Badge({ children, tone }) {
  const cls = 'tv2p-badge' + (tone ? ` tv2p-badge--${tone}` : '')
  return h('span', { className: cls }, children)
}

/** run 状态 → 语义色 tone（running/done/error，其余 muted）。 */
function runStatusTone(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'running' || s === 'stopping') return 'info'
  if (s === 'done' || s === 'completed' || s === 'success') return 'ok'
  if (s === 'error' || s === 'failed' || s === 'killed') return 'danger'
  return 'muted'
}

// ---------- 状态带：项目标识 + 覆盖率 + 统计 + 下一步引导 + 运行状态 ----------

/** 项目标识 + 常驻切换器（母文件夹多游戏）：单候选纯文本，多候选项可点弹出列表。 */
function ProjectChip({ project, projects, onAction }) {
  const [open, setOpen] = React.useState(false)
  const name = projectLabelOf(project.dir, projects)
  const candidates = (projects ?? []).filter((d) => d !== project.dir)
  if (candidates.length === 0) {
    return h('div', { className: 'tv2p-cell' },
      h('div', { className: 'tv2p-label' }, '项目'),
      h('div', { className: 'tv2p-value', style: { fontSize: 13 } }, `${name} · ${project.lang || ''}`),
    )
  }
  return h('div', { className: 'tv2p-cell', style: { position: 'relative' } },
    h('button', {
      type: 'button',
      className: 'tv2p-btn',
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      title: '切换要查看的游戏',
      onClick: () => setOpen(!open),
    }, `${name} · ${project.lang || ''} ▾`),
    open ? h('div', { className: 'tv2p-menu', role: 'listbox' },
      candidates.map((d) => h('button', {
        key: d,
        type: 'button',
        className: 'tv2p-btn tv2p-menuItem',
        role: 'option',
        onClick: () => { setOpen(false); onAction(projectSwitchCommand(d)) },
      }, projectLabelOf(d, projects))),
    ) : null,
  )
}

/** 状态带（替换旧 OverviewBar）：不再提供任务按钮；刷新为图标按钮（轮询已接管大部分场景）。 */
function StatusBand({ panel, project, projects, onRefresh, onSuggest, onJump, onAction }) {
  const p = panel.progress ?? {}
  const safe = Math.max(0, Math.min(100, Number(p.coveragePct) || 0))
  const running = activeRunOf(panel)
  const next = nextStepOf(panel)
  const onNext = () => {
    if (!next) return
    if (next.action.type === 'jump') onJump(next.action.target)
    else if (next.action.type === 'phrase') onSuggest(next.action.phrase)
  }
  return h('div', { className: 'tv2p-section' },
    h('div', { className: 'tv2p-row' },
      project ? h(ProjectChip, { project, projects, onAction }) : null,
      h('div', { className: 'tv2p-cell' },
        h('div', { className: 'tv2p-label' }, '覆盖率'),
        h('div', { className: 'tv2p-value' + (safe >= 100 ? ' tv2p-value--ok' : '') }, `${safe}%`),
      ),
      h('div', { className: 'tv2p-bar', role: 'progressbar', 'aria-valuenow': safe, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { className: 'tv2p-barfill', style: { width: `${safe}%` } })),
      h('div', { className: 'tv2p-cell' },
        h('div', { className: 'tv2p-label' }, '已译'),
        h('div', { className: 'tv2p-value' }, `${p.translated ?? 0}/${p.units ?? 0}`)),
      h('div', { className: 'tv2p-cell' },
        h('div', { className: 'tv2p-label' }, '待译'),
        h('div', { className: 'tv2p-value' }, `${p.pending ?? 0}`)),
      h('div', { className: 'tv2p-cell' },
        h('div', { className: 'tv2p-label' }, '失败'),
        h('div', { className: 'tv2p-value' }, `${p.missing ?? 0}`)),
      running ? h('span', { className: 'tv2p-dot', title: `有任务运行中（${running.kind || 'run'}）`, 'aria-label': '任务运行中' }) : null,
      h(IconButton, { icon: 'refresh', title: '刷新面板数据', onClick: onRefresh }),
    ),
    next ? h('div', { className: 'tv2p-next' },
      h('span', { className: 'tv2p-nextLabel' }, '下一步'),
      h('span', { className: 'tv2p-nextTitle' }, next.title),
      h('button', {
        type: 'button',
        className: 'tv2p-btn',
        onClick: onNext,
        title: next.action.type === 'jump' ? '跳到对应卡片处理' : '把话术填入输入框（发送前可修改）',
      }, next.action.type === 'jump' ? '去处理' : '填入话术'),
    ) : null,
    // 推敲审批原地上移：不再单独占一张「待办」卡，直接渲染在下一步行下方。
    (Array.isArray(panel.deliberation) ? panel.deliberation : []).length > 0
      ? h('div', { className: 'tv2p-item', style: { marginTop: 8 } },
        h('div', { className: 'tv2p-itemTitle' },
          h('span', null, '推敲审批'),
          h(Badge, { tone: 'warn' }, `${panel.deliberation.length} 条待定`),
        ),
        panel.deliberation.map((d) => h('div', { key: d.id, style: { margin: '6px 0' } },
          h('div', { className: 'tv2p-itemTitle', style: { fontWeight: 400 } },
            h('span', { style: { flex: 1, minWidth: 0 } }, `${d.source} → ${d.target}`),
            d.confidence ? h(Badge, null, d.confidence) : null,
          ),
          d.rationale ? h('div', { className: 'tv2p-hint' }, d.rationale) : null,
          h('div', { className: 'tv2p-actions' },
            h('button', { type: 'button', className: 'tv2p-btn', onClick: () => onAction(deliberateApproveCommand([d.id])) }, '批准锁定'),
            h('button', { type: 'button', className: 'tv2p-btn', onClick: () => onAction(deliberateRejectCommand([d.id])) }, '拒绝'),
          ),
        )),
      )
      : null,
  )
}

// ---------- 世界书 ----------

/** 世界书单条：行 = 箭头 + 标题 + 徽标（整体可点展开）；编辑/删除/确认收进展开区。 */
function WorldbookEntry({ entry, onAction }) {
  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const [title, setTitle] = React.useState(entry.title || '')
  const [content, setContent] = React.useState(entry.content || '')
  const [keywords, setKeywords] = React.useState((entry.keywords || []).join(','))
  const [linked, setLinked] = React.useState(entry.linkedTerm || '')
  const [refs, setRefs] = React.useState((entry.sourceRefs || []).join(','))
  const canSubmit = title.trim().length > 0
  const submitEdit = () => {
    const cmd = worldbookEditCommand({
      id: entry.id,
      title: title.trim() || undefined,
      content: content || undefined,
      keywords: keywords ? keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined,
      linkedTerm: linked || undefined,
      sourceRefs: refs ? refs.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined,
    })
    if (cmd) {
      onAction(cmd)
      setEditing(false)
    }
  }
  // 删除两段式确认：第一次点垃圾桶进入确认态，再点「确认删除」才执行（3 秒不点自动复位）。
  const askDelete = () => {
    setConfirmingDelete(true)
    window.setTimeout(() => setConfirmingDelete(false), 3000)
  }
  const tone = WORLDBOOK_STATUS_TONE[entry.status]
  return h('div', { className: 'tv2p-item', key: entry.id, style: { padding: '2px 0' } },
    h('div', {
      className: 'tv2p-itemTitle tv2p-rowclick',
      style: { cursor: 'pointer', userSelect: 'none', padding: '4px 4px', margin: '0 -4px' },
      onClick: () => setOpen(!open),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(!open)
        }
      },
      tabIndex: 0,
      role: 'button',
      'aria-expanded': open,
    },
      h(Chevron, { open }),
      h('span', { style: { flex: 1, minWidth: 0 } }, entry.title || '（未命名）'),
      h(Badge, null, entry.kind || 'keyword'),
      h(Badge, { tone }, WORLDBOOK_STATUS_LABEL[entry.status] || entry.status || ''),
    ),
    open ? h('div', { className: 'tv2p-exp-body' },
      entry.content ? h('div', null, entry.content) : h('div', { className: 'tv2p-hint' }, '无内容。'),
      entry.linkedTerm ? h('div', { className: 'tv2p-hint' }, `关联术语：${entry.linkedTerm}`) : null,
      Array.isArray(entry.sourceRefs) && entry.sourceRefs.length > 0
        ? h('div', { className: 'tv2p-hint tv2p-mono' }, `来源：${entry.sourceRefs.join(', ')}`)
        : null,
      h('div', { className: 'tv2p-actions' },
        entry.status === 'proposed'
          ? h('button', { type: 'button', className: 'tv2p-btn', onClick: () => onAction(worldbookConfirmCommand([entry.id])) }, '确认')
          : null,
        h(IconButton, { icon: 'pencil', title: '编辑条目', onClick: () => setEditing(!editing) }),
        confirmingDelete
          ? h('button', {
            type: 'button',
            className: 'tv2p-btn tv2p-btn--danger',
            onClick: () => { setConfirmingDelete(false); onAction(worldbookDeleteCommand([entry.id])) },
          }, '确认删除')
          : h(IconButton, { icon: 'trash', title: '删除条目', danger: true, onClick: askDelete }),
      ),
      editing ? h('div', null,
        h('div', { className: 'tv2p-edit-row' },
          h('input', { className: 'tv2p-input', placeholder: '标题', value: title, onChange: (e) => setTitle(e.target.value) }),
          h('button', { type: 'button', className: 'tv2p-btn', onClick: submitEdit, disabled: !canSubmit }, '保存'),
        ),
        h('div', { className: 'tv2p-edit-row' },
          h('input', { className: 'tv2p-input', placeholder: '关键词（逗号分隔）', value: keywords, onChange: (e) => setKeywords(e.target.value) }),
          h('input', { className: 'tv2p-input', placeholder: '关联术语（可选）', value: linked, onChange: (e) => setLinked(e.target.value) }),
        ),
        h('div', { className: 'tv2p-edit-row' },
          h('input', { className: 'tv2p-input', placeholder: '来源（可选，逗号分隔）', value: refs, onChange: (e) => setRefs(e.target.value) }),
        ),
        h('textarea', { className: 'tv2p-input', placeholder: '内容', value: content, onChange: (e) => setContent(e.target.value), rows: 3, style: { width: '100%', boxSizing: 'border-box' } }),
      ) : null,
    ) : null,
  )
}

const WB_KINDS = ['name', 'term', 'setting', 'lore', 'constant']

/** 内联添加表单（世界书分区内部，非独立大表单）。 */
function AddForm({ onAction }) {
  const [kind, setKind] = React.useState('name')
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [keywords, setKeywords] = React.useState('')
  const [linked, setLinked] = React.useState('')
  const [refs, setRefs] = React.useState('')
  const canSubmit = title.trim().length > 0
  const submit = () => {
    onAction(worldbookAddCommand({
      wbKind: kind,
      title: title.trim(),
      content: content.trim(),
      keywords: keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      linkedTerm: linked.trim() || undefined,
      sourceRefs: refs.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    }))
    setTitle(''); setContent(''); setKeywords(''); setLinked(''); setRefs('')
  }
  return h('div', { className: 'tv2p-item' },
    h('div', { className: 'tv2p-itemTitle' }, h('span', null, '内联添加')),
    h('div', { className: 'tv2p-edit-row' },
      h('select', { className: 'tv2p-input', value: kind, onChange: (e) => setKind(e.target.value), 'aria-label': '条目类别' },
        WB_KINDS.map((k) => h('option', { key: k, value: k }, k))),
      h('input', { className: 'tv2p-input', placeholder: '标题（中文名（English Name））', value: title, onChange: (e) => setTitle(e.target.value) }),
      h('button', { type: 'button', className: 'tv2p-btn', onClick: submit, disabled: !canSubmit }, '添加'),
    ),
    h('div', { className: 'tv2p-edit-row' },
      h('input', { className: 'tv2p-input', placeholder: '关键词（逗号分隔）', value: keywords, onChange: (e) => setKeywords(e.target.value) }),
      h('input', { className: 'tv2p-input', placeholder: '关联术语（可选）', value: linked, onChange: (e) => setLinked(e.target.value) }),
      h('input', { className: 'tv2p-input', placeholder: '来源（可选）', value: refs, onChange: (e) => setRefs(e.target.value) }),
    ),
    h('textarea', { className: 'tv2p-input', placeholder: '内容（可选）', value: content, onChange: (e) => setContent(e.target.value), rows: 2, style: { width: '100%', boxSizing: 'border-box' } }),
  )
}

/** 世界书分区：列表（待确认置顶）+ 批量确认 + 内联添加，整个分区可折叠。 */
function WorldbookCard({ panel, onAction }) {
  const list = sortWorldbookProposedFirst(panel.worldbook ?? [])
  const proposed = list.filter((e) => e && e.status === 'proposed')
  return h(Section, { id: 'tv2p-worldbook', title: '世界书',
    badge: h(Badge, { tone: proposed.length > 0 ? 'warn' : null },
      `${list.length} 条${proposed.length > 0 ? ` · 待确认 ${proposed.length}` : ''}`) },
    // 批量确认（原「待办」卡动作归位）：有待确认条目时置顶给一键入口。
    proposed.length > 0 ? h('div', { className: 'tv2p-actions', style: { margin: '0 0 8px' } },
      h('button', {
        type: 'button',
        className: 'tv2p-btn',
        title: '一次性确认全部待确认条目',
        onClick: () => onAction(worldbookConfirmCommand(proposed.map((e) => e.id))),
      }, `全部确认（${proposed.length}）`),
    ) : null,
    list.length === 0 ? h('p', { className: 'tv2p-hint' }, '暂无条目，可用下方「内联添加」。') : null,
    list.map((e) => h(WorldbookEntry, { key: e.id, entry: e, onAction })),
    h(AddForm, { key: 'add', onAction }),
  )
}

/**
 * 单场景单元明细（懒加载）：场景行点开后挂载，一次拉取源文/译文/状态。
 * 与 PromptList 同一 fetch 范式；失败显形不吞错。
 */
function SceneUnits({ dir, sessionId, sceneId }) {
  const [state, setState] = React.useState({ loading: true, units: null, error: '' })
  React.useEffect(() => {
    let alive = true
    setState({ loading: true, units: null, error: '' })
    fetch(sceneUnitsUrlOf(dir, sessionId, sceneId))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (!alive) return
        if (json && json.ok) setState({ loading: false, units: Array.isArray(json.units) ? json.units : [], error: '' })
        else setState({ loading: false, units: null, error: (json && json.message) || '加载失败' })
      })
      .catch((err) => {
        if (alive) setState({ loading: false, units: null, error: err instanceof Error ? err.message : '加载失败' })
      })
    return () => { alive = false }
  }, [dir, sessionId, sceneId])

  if (state.loading) return h('p', { className: 'tv2p-hint' }, '单元明细加载中…')
  if (state.error) return h('p', { className: 'tv2p-err' }, `单元明细加载失败：${state.error}`)
  if (state.units.length === 0) return h('p', { className: 'tv2p-hint' }, '该场景无可译单元。')
  return h('div', { className: 'tv2p-units' },
    state.units.map((u) => h('div', { className: 'tv2p-item', key: u.unitId, style: { paddingTop: 6 } },
      h('div', { className: 'tv2p-itemTitle' },
        h(Badge, { tone: unitStatusTone(u.status) }, unitStatusLabel(u.status)),
        u.speaker ? h('span', { className: 'tv2p-mono' }, u.speaker) : null,
        h('span', { className: 'tv2p-mono', style: { marginLeft: 'auto' } }, u.unitId),
      ),
      h('div', { className: 'tv2p-unitSrc' }, u.source),
      h('div', { className: 'tv2p-unitTl' }, u.translation || '（无译文）'),
    )),
  )
}

/**
 * 单场景行（进度明细条目）：行 = chevron + 标题 + 计数徽标，整体可点展开单元明细。
 * 展开时才挂载 SceneUnits（懒加载，不拖慢面板首屏）。
 */
function ProgressSceneRow({ scene, dir, sessionId }) {
  const [open, setOpen] = React.useState(false)
  const toggle = () => setOpen(!open)
  return h('div', { className: 'tv2p-item', key: scene.sceneId },
    h('div', {
      className: 'tv2p-itemTitle tv2p-rowclick',
      style: { cursor: 'pointer', userSelect: 'none', padding: '4px 4px', margin: '0 -4px' },
      onClick: toggle,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggle()
        }
      },
      tabIndex: 0,
      role: 'button',
      'aria-expanded': open,
      'aria-label': `场景「${scene.title || scene.sceneId}」单元明细`,
      title: '点开查看该场景的单元明细',
    },
      h(Chevron, { open }),
      h('span', { style: { flex: 1, minWidth: 0 } }, scene.title || scene.sceneId),
      h(Badge, { tone: scene.translated >= scene.units ? 'ok' : null }, `${scene.translated}/${scene.units}`),
    ),
    open ? h(SceneUnits, { dir, sessionId, sceneId: scene.sceneId }) : null,
  )
}

/**
 * 进度分区：全场景列表（滚动容器，不再「…等 N 个场景」截断——被截掉的行永远点不开）；
 * 场景行可点开看单元明细（懒加载）。
 */
function ProgressCard({ panel, dir, sessionId }) {
  const p = panel.progress ?? {}
  const scenes = p.byScene ?? []
  return h(Section, { title: '进度明细', badge: h(Badge, null, `${p.scenes ?? 0} 场景`) },
    scenes.length === 0 ? h('p', { className: 'tv2p-hint' }, '暂无场景数据。') : null,
    scenes.length > 0 ? h('div', { className: 'tv2p-scenes' },
      scenes.map((s) => h(ProgressSceneRow, { key: s.sceneId, scene: s, dir, sessionId })),
    ) : null,
  )
}

/** 拉取指定 run 的 recording 快照（/tav2/panel/prompts）。 */
function PromptList({ dir, sessionId, runId }) {
  const [loading, setLoading] = React.useState(true)
  const [prompts, setPrompts] = React.useState([])
  React.useEffect(() => {
    let alive = true
    setLoading(true)
    const url = `/tav2/panel/prompts?dir=${encodeURIComponent(dir)}&session=${encodeURIComponent(sessionId ?? '')}&runId=${encodeURIComponent(runId)}`
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (!alive) return
        setPrompts(Array.isArray(json.prompts) ? json.prompts : [])
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setPrompts([])
        setLoading(false)
      })
    return () => { alive = false }
  }, [dir, sessionId, runId])
  if (loading) return h('p', { className: 'tv2p-hint' }, '快照加载中…')
  if (prompts.length === 0) return h('p', { className: 'tv2p-hint' }, '该运行无可解析快照（未开启 debug.request_snapshot_dir 或该次运行未记录）。')
  const tokenOf = (p) => {
    const n = (Number(p.promptTokens) || 0) + (Number(p.completionTokens) || 0)
    return n > 0 ? `${(n / 1000).toFixed(1)}k tok` : ''
  }
  return prompts.map((p) => h(Section, {
    key: p.seq ?? 0,
    title: `${stageLabelOf(p.stage)}${p.sceneId ? ` · ${p.sceneId}` : ''} · ${p.elapsedMs ?? 0}ms${tokenOf(p) ? ` · ${tokenOf(p)}` : ''}`,
    defaultOpen: false,
  },
    p.system ? h('div', { className: 'tv2p-monopre' }, `【system】\n${p.system}`) : null,
    Array.isArray(p.messages) && p.messages.length > 0
      ? h('div', { className: 'tv2p-monopre' }, p.messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n'))
      : null,
    p.responseText ? h('div', { className: 'tv2p-monopre' }, `【response】\n${p.responseText}`) : null,
    p.error ? h('div', { className: 'tv2p-err' }, `错误：${p.error}`) : null,
  ))
}

/** 单条活动流行（stage · 场景 · 耗时 · tokens）。 */
function FeedRow({ p }) {
  const tokens = (Number(p.promptTokens) || 0) + (Number(p.completionTokens) || 0)
  return h('div', { className: 'tv2p-feedRow' + (p.error ? ' tv2p-feedRow--err' : '') },
    h('span', { className: 'tv2p-feedStage' }, stageLabelOf(p.stage)),
    h('span', { className: 'tv2p-feedScene' }, p.error ? `错误：${p.error}` : (p.sceneId || '')),
    h('span', { className: 'tv2p-feedMeta' },
      `${p.elapsedMs ?? 0}ms${tokens > 0 ? ` · ${(tokens / 1000).toFixed(1)}k` : ''}`),
  )
}

/**
 * 实时活动区：有运行中 run 时挂载，每 4s 拉该 run 快照尾部（最后 30 条）。
 * 展示当前动作、最近调用流（新的在上）、窗口内小计；运行结束由父级卸载。
 */
function LiveRun({ dir, sessionId, run }) {
  const [prompts, setPrompts] = React.useState(null) // null = 尚未取到数据
  React.useEffect(() => {
    let alive = true
    const fetchOnce = async () => {
      try {
        const url = `/tav2/panel/prompts?dir=${encodeURIComponent(dir)}&session=${encodeURIComponent(sessionId ?? '')}&runId=${encodeURIComponent(run.runId)}&tail=1&n=30`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (alive) setPrompts(Array.isArray(json.prompts) ? json.prompts : [])
      } catch {
        if (alive) setPrompts((prev) => (prev ?? []))
      }
    }
    void fetchOnce()
    const timer = window.setInterval(() => { void fetchOnce() }, 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [dir, sessionId, run.runId])

  const stats = liveStatsOf(prompts ?? [])
  const startedMs = Date.parse(String(run.startedAt ?? ''))
  const elapsed = Number.isFinite(startedMs) ? formatDuration((Date.now() - startedMs) / 1000) : ''
  const last = stats.last
  const nowText = last
    ? `${stageLabelOf(last.stage)}${last.sceneId ? ` · ${last.sceneId}` : ''} · 上一次调用 ${last.elapsedMs ?? 0}ms`
    : '等待首次调用落盘…'
  return h('div', { className: 'tv2p-live' },
    h('div', { className: 'tv2p-liveHead' },
      h('span', { className: 'tv2p-dot', 'aria-label': '任务运行中' }),
      h('span', { className: 'tv2p-liveNow' }, nowText),
      elapsed ? h('span', { className: 'tv2p-feedMeta' }, elapsed) : null,
    ),
    prompts !== null && prompts.length > 0
      ? h('div', { className: 'tv2p-feed' },
        (prompts.slice(-8).reverse()).map((p) => h(FeedRow, { key: p.seq ?? `${p.stage}-${p.elapsedMs}` })),
      )
      : null,
    h('p', { className: 'tv2p-liveSub' },
      `最近 ${stats.calls} 次调用 · ${(stats.tokens / 1000).toFixed(1)}k tokens · 涉及 ${stats.scenes} 个场景`
      + (stats.errors > 0 ? ` · ${stats.errors} 次错误` : '')),
  )
}

/**
 * 任务动态（原「翻译过程」）：AI 正在做什么第一时间可见——运行中实时活动区置顶，
 * 随后翻译失败单元明细（原「待办」卡独有信息归位）+ 待关注 flags + 用量小计 + 运行历史。
 * flagged-unit 的 flag 行与失败明细是同一批单元，有明细时只渲染明细避免重复计数。
 */
function ProcessCard({ panel, dir, sessionId }) {
  const runs = panel.runs ?? []
  const usage = panel.usage ?? {}
  const runPromptDirs = panel.runPromptDirs ?? {}
  const flags = panel.flags ?? []
  const failedUnits = Array.isArray(panel.failedUnits) ? panel.failedUnits : []
  const flagsShown = flags.filter((f) => !(f.type === 'flagged-unit' && failedUnits.length > 0))
  const active = activeRunOf(panel)
  return h(Section, { title: '任务动态',
    badge: flags.length > 0 ? h(Badge, { tone: 'warn' }, `${flags.length} 项待关注`) : null },
    active ? h(LiveRun, { dir, sessionId, run: active }) : null,
    failedUnits.length > 0 ? h('div', { className: 'tv2p-item' },
      h('div', { className: 'tv2p-itemTitle' },
        h('span', null, '翻译失败单元'),
        h(Badge, { tone: 'danger' }, `${failedUnits.length} 条`),
      ),
      failedUnits.slice(0, 5).map((f) => h('div', { key: f.approvalId ?? f.unitId, style: { margin: '6px 0' } },
        h('div', null, f.source || f.unitId),
        h('div', { className: 'tv2p-hint' },
          `${f.sceneTitle || f.sceneId || '未知场景'}${f.reason ? ` · ${f.reason}` : ''}`),
      )),
      failedUnits.length > 5 ? h('p', { className: 'tv2p-hint' }, `…等 ${failedUnits.length - 5} 条`) : null,
      h('p', { className: 'tv2p-hint' }, '重跑翻译会自动重试失败单元（下一步引导有入口）。'),
    ) : null,
    flagsShown.length > 0 ? flagsShown.map((f) => h('div', { className: 'tv2p-item', key: f.type },
      h('div', { className: 'tv2p-itemTitle' },
        h('span', { style: { flex: 1, minWidth: 0 } }, f.label),
        h(Badge, { tone: f.type === 'flagged-unit' ? 'danger' : f.type === 'pending-approval' ? 'warn' : null }, `${f.count}`),
      ),
    )) : null,
    h('div', { className: 'tv2p-row' }, [
      h('div', { className: 'tv2p-cell', key: 'runs' },
        h('div', { className: 'tv2p-label' }, '运行次数'), h('div', { className: 'tv2p-value' }, `${usage.runs ?? 0}`)),
      h('div', { className: 'tv2p-cell', key: 'calls' },
        h('div', { className: 'tv2p-label' }, '调用'), h('div', { className: 'tv2p-value' }, `${usage.calls ?? 0}`)),
      h('div', { className: 'tv2p-cell', key: 'tokens' },
        h('div', { className: 'tv2p-label' }, 'tokens'), h('div', { className: 'tv2p-value' }, `${(usage.totalTokens ?? 0).toLocaleString()}`)),
      h('div', { className: 'tv2p-cell', key: 'elapsed' },
        h('div', { className: 'tv2p-label' }, '耗时'), h('div', { className: 'tv2p-value' }, `${usage.elapsedSeconds ?? 0}s`)),
    ]),
    runs.length === 0
      ? h('p', { className: 'tv2p-hint' }, '暂无运行记录。')
      : runs.map((r) => {
        const snapshotFile = runPromptDirs[r.runId]
        const tone = runStatusTone(r.status)
        const time = `${formatTime(r.startedAt)}${r.startedAt && r.finishedAt ? ' → ' : ''}${formatTime(r.finishedAt)}`
        const summary = runSummaryOf(r.summary)
        return h(Section, {
          key: r.runId,
          title: `${r.kind || 'run'}`,
          badge: h(Badge, { tone }, `${r.status || ''} · ${time}`),
          defaultOpen: false,
        },
          summary ? h('p', { className: 'tv2p-hint' }, summary) : null,
          snapshotFile
            ? h(PromptList, { dir, sessionId, runId: r.runId })
            : h('p', { className: 'tv2p-hint' }, '本次运行无 recording 快照（需 config.debug.request_snapshot_dir）。'),
        )
      }),
  )
}

/** extras 槽：未来功能的挂载点（当前渲染占位）。 */
function ExtrasSlot() {
  return h('div', { className: 'tv2p-slot', 'data-slot': 'extras' }, '未来扩展功能占位')
}

/**
 * 「翻译」标签页主体。卡片注册表：按 SLOTS 顺序渲染，未来功能在对应槽位挂号即可。
 *
 * 数据流：模块级缓存（key=会话|项目，组件卸载不丢）→ 进入标签页先用缓存即时渲染
 * （stale-while-revalidate，不再整页打回加载占位）→ 后台拉新静默更新；有运行中任务时
 * 5s 轮询；写操作提交后 2s 轮询直到数据变化（最多 15 次）。
 */

/** 模块级面板缓存：key = `${sessionId}|${dir}` → { data }（panelStateOf 结果）。 */
const panelCache = new Map()

/** 快照变化指纹（全量 JSON；面板体量级可用，简单可靠）。 */
function panelKeyOf(data) {
  if (data && data.kind === 'ok') return JSON.stringify(data.panel)
  return JSON.stringify(data ?? null)
}

export function WorkspacePanel({ sessionId, useWorkspaces, inputActions }) {
  const items = useWorkspaces((s) => (s && Array.isArray(s.items) ? s.items : [])) ?? []
  const dir = workspaceDirOf(sessionId, items)
  const cacheKey = `${sessionId}|${dir}`
  const [state, setState] = React.useState(() => {
    const cached = panelCache.get(cacheKey)
    return cached
      ? { status: 'ready', data: cached.data, dir, stale: false }
      : { status: 'loading', data: null, dir }
  })
  // 最近一次成功快照的指纹（写操作后的「变化即停」轮询用）。
  const lastKeyRef = React.useRef(panelKeyOf(state.data))

  const doFetch = React.useCallback(async () => {
    const url = `/tav2/panel?dir=${encodeURIComponent(dir)}&session=${encodeURIComponent(sessionId ?? '')}`
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const data = panelStateOf(json)
      panelCache.set(cacheKey, { data })
      setState({ status: 'ready', data, dir, stale: false })
      lastKeyRef.current = panelKeyOf(data)
      return data
    } catch {
      return null
    }
  }, [dir, sessionId, cacheKey])

  const load = React.useCallback(() => {
    if (!dir) {
      setState({ status: 'ready', data: { kind: 'no-project', message: '' }, dir: '' })
      return
    }
    setState((prev) => (
      // 缓存命中且同项目 → 保留旧树后台刷新（SWR）；否则才进加载占位。
      prev.status === 'ready' && prev.data && prev.dir === dir
        ? prev
        : panelCache.get(cacheKey)
          ? { status: 'ready', data: panelCache.get(cacheKey).data, dir, stale: false }
          : { status: 'loading', data: null, dir }
    ))
    void doFetch().then((data) => {
      // 后台刷新失败：已有数据则标记 stale（顶部横幅），首次失败才进错误态。
      if (data === null) {
        setState((prev) => (
          prev.status === 'ready' && prev.data && prev.dir === dir
            ? { ...prev, stale: true }
            : { status: 'error', data: null, dir }
        ))
      }
    })
  }, [dir, cacheKey, doFetch])

  React.useEffect(() => { load() }, [load])

  // 有运行中任务 → 每 5s 轮询（任务结束或切走标签自动停）。
  React.useEffect(() => {
    const panel = state.status === 'ready' && state.data && state.data.kind === 'ok' ? state.data.panel : null
    if (!panel || !activeRunOf(panel)) return undefined
    const timer = window.setInterval(() => { void doFetch() }, 5000)
    return () => window.clearInterval(timer)
  }, [state, doFetch])

  const onAction = React.useCallback((command) => {
    if (!command) return
    const beforeKey = lastKeyRef.current
    try {
      if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(command)
      if (inputActions && typeof inputActions.submit === 'function') inputActions.submit()
    } catch {
      // 注入失败不阻断刷新。
    }
    // 提交后轮询：2s 一次、最多 15 次；数据有变化即停（任务未跑完则靠运行中轮询接力）。
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      void doFetch().then((data) => {
        if (data === null) return
        if (attempts >= 15 || panelKeyOf(data) !== beforeKey) window.clearInterval(timer)
      })
    }, 2000)
  }, [inputActions, doFetch])

  // 「下一步」聊天动作：只把话术填入输入框，不提交（由用户确认后发送）。
  const onSuggest = React.useCallback((phrase) => {
    if (!phrase) return
    try {
      if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(phrase)
    } catch {
      // 注入失败静默。
    }
  }, [inputActions])

  const onJump = React.useCallback((target) => {
    const el = document.getElementById(target)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const placeholder = (title, hint) => h('div', { className: 'tv2p-section' },
    h('div', { className: 'tv2p-head' }, h('span', null, title)),
    hint ? h('p', { className: 'tv2p-hint' }, hint) : null,
  )

  let body
  if (state.status === 'loading') {
    body = placeholder('翻译工作台', '加载中…')
  } else if (state.status === 'error') {
    body = h('div', { className: 'tv2p-section' },
      h('p', { className: 'tv2p-err' }, '面板数据加载失败，请重试。'),
      h('div', { className: 'tv2p-actions' }, h('button', { type: 'button', className: 'tv2p-btn', onClick: () => void load() }, '重试')),
    )
  } else {
    const data = state.data
    if (data.kind === 'no-project') {
      body = placeholder('翻译工作台', '当前会话未初始化翻译项目。对助手说「初始化游戏翻译」即可开始。')
    } else if (data.kind === 'not-initialized') {
      body = placeholder('翻译工作台', '已找到 config.yaml，但项目尚未初始化。请先对助手说「初始化游戏翻译」。')
    } else if (data.kind === 'multiple-projects') {
      const candidates = data.candidates ?? []
      body = h('div', { className: 'tv2p-section' },
        h('div', { className: 'tv2p-head' }, h('span', null, '翻译工作台')),
        h('p', { className: 'tv2p-hint' }, `工作区下发现 ${candidates.length} 个项目，请选择要查看的游戏：`),
        h('div', { className: 'tv2p-actions' },
          candidates.map((c) => h('button', {
            key: c,
            type: 'button',
            className: 'tv2p-btn',
            onClick: () => onAction(projectSwitchCommand(c)),
          }, c.split(/[\\/]/).filter(Boolean).pop() || c)),
        ),
        h('p', { className: 'tv2p-hint' }, '选择后写入本会话，面板与翻译工具将一致跟随该游戏。'),
      )
    } else if (data.kind === 'error') {
      body = placeholder('翻译工作台', data.message || '面板数据读取失败。')
    } else {
      const panel = data.panel
      const project = data.project ?? null
      const projects = data.projects ?? null
      // 卡片注册表（SLOTS 顺序）：未来功能挂在对应槽位。
      const slots = extensionSlotsOf()
      const cards = []
      for (const slot of slots) {
        if (slot === 'overview') cards.push(h(StatusBand, { key: slot, panel, project, projects, onRefresh: () => void load(), onSuggest, onJump, onAction }))
        else if (slot === 'process') cards.push(h(ProcessCard, { key: slot, panel, dir, sessionId }))
        else if (slot === 'worldbook') cards.push(h(WorldbookCard, { key: slot, panel, onAction }))
        else if (slot === 'progress') cards.push(h(ProgressCard, { key: slot, panel, dir, sessionId }))
        else if (slot === 'extras') cards.push(h(ExtrasSlot, { key: slot }))
        else cards.push(null)
      }
      body = cards
    }
  }

  // 后台刷新失败但保留了旧数据时的提示横幅（不吞错，也不清空界面）。
  const staleBanner = state.status === 'ready' && state.stale
    ? h('div', { className: 'tv2p-section', style: { padding: '6px 12px' } },
      h('p', { className: 'tv2p-err', style: { margin: 0 } }, '面板数据刷新失败，以下为上次数据。请检查本地服务后重试。'))
    : null

  return h('div', { className: 'tv2p' }, staleBanner, body)
}
