/**
 * dsh-plugin-tav2 浏览器端（client module）：为 tav2_* 工具注册对话内富卡片。
 *
 * 数据通道（D1）：服务端 output.presentationMeta 投影 → 会话日志
 * ToolResultNode.meta → 卡片读取 block.meta 渲染。卡片按 wire 工具名 keyed，
 * 工具不出现在会话里卡片自然不出现（预设门控自动成立，SPEC 验收 5）。
 *
 * 设置卡（设置 → 插件 → dsh-plugin-tav2）手写镜像宿主标准卡片样式与交互：
 * 展开头 + Save/Discard + 暂存式编辑 + 覆盖标记 + 密码框；不 import 宿主 UI 组件。
 * /tav2-mode 命令不注册自定义 commandview，宿主自动渲染 GenericCommandCard。
 *
 * 本文件为纯 ESM（无 JSX/TS），由 scripts/build-client.mjs 以 lazy-CJS 包装
 * 构建为 dist/client.js；react 是平台模块（外部），其余依赖全部内联。
 */
import React from 'react'
import { parseJobDetail } from './projection.js'

const CARD_STYLE = {
  border: '1px solid rgba(127, 127, 127, 0.35)',
  borderRadius: 8,
  padding: '10px 12px',
  margin: '4px 0',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  color: 'inherit',
}
const TITLE_STYLE = { fontWeight: 600, marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }
const ROWS_STYLE = { display: 'flex', gap: 14, flexWrap: 'wrap' }
const FIELD_STYLE = { minWidth: 88 }
const LABEL_STYLE = { color: 'rgba(127,127,127,0.9)', fontSize: 11 }
const VALUE_STYLE = { fontSize: 15, fontWeight: 600 }
const NOTE_STYLE = { marginTop: 6, color: 'rgba(127,127,127,0.9)', whiteSpace: 'pre-wrap' }
const BADGE_STYLE = {
  fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.4)',
}

function h(type, props, ...children) {
  return React.createElement(type, props ?? null, ...children)
}

/**
 * 设置卡样式：镜像宿主「设置 → 插件」卡（fields/PluginCard 的视觉 token），
 * 全部走 --dsw-alias-* 主题变量，亮/暗色自动跟随宿主。
 */
const TAV2_SETTINGS_CSS = `
.tv2-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}
.tv2-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.tv2-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.tv2-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.tv2-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.tv2-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.tv2-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.tv2-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.tv2-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.tv2-chevronOpen{transform:rotate(180deg)}
.tv2-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.tv2-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.tv2-sectionTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;margin:12px 0 0}
.tv2-sectionHint{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:12px;line-height:1.5}
.tv2-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.tv2-field+.tv2-field{border-top:1px solid var(--dsw-alias-border-l2)}
.tv2-head{align-items:center;gap:8px;display:flex}
.tv2-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.tv2-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.tv2-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.tv2-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:0;font-size:12px;line-height:1.5}
.tv2-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.tv2-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.tv2-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.tv2-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.tv2-inputInvalid{border-color:var(--dsw-alias-label-error)}
.tv2-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.tv2-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.tv2-chips{display:flex;flex-wrap:wrap;gap:6px}
.tv2-chip{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;border-radius:999px;padding:1px 10px;font-size:12px;line-height:1.5}
.tv2-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.tv2-checkboxRow{display:flex;align-items:center;gap:8px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.tv2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));column-gap:12px}
.tv2-cell{flex-direction:column;gap:6px;padding:8px 0;display:flex}
.tv2-cell .tv2-label{flex:none}
.tv2-channelBox{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-top:8px;padding:0 12px}
.tv2-channelBoxInvalid{border-color:var(--dsw-alias-label-error)}
.tv2-channelHead{display:flex;align-items:center;gap:8px;padding-top:8px}
.tv2-channelHead .tv2-label{flex:1}
.tv2-add{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-brand-primary);background:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;margin-top:8px;width:100%}
.tv2-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.tv2-add:disabled{opacity:.4;cursor:default}
.tv2-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.tv2-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.tv2-discard,.tv2-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.tv2-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.tv2-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.tv2-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.tv2-discard:disabled,.tv2-save:disabled{opacity:.4;cursor:default}
.tv2-error{color:var(--dsw-alias-label-error);margin:8px 0 0;font-size:12px;white-space:pre-wrap}
`
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-plugin-tav2/settings"]') === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-tav2'
  tag.dataset.pluginCss = 'dsh-plugin-tav2/settings'
  tag.textContent = TAV2_SETTINGS_CSS
  document.head.appendChild(tag)
}

/** 取已结算工具结果的 presentationMeta；运行中/缺失返回 undefined。 */
function metaOf(block) {
  if (block == null || block.kind !== 'tool-result') return undefined
  return block.meta
}

/** 通用卡片壳：标题 + 徽标 + 子内容。 */
function Card({ title, badge, children }) {
  return h('div', { style: CARD_STYLE },
    h('div', { style: TITLE_STYLE },
      h('span', null, title),
      badge !== undefined && h('span', { style: BADGE_STYLE }, badge),
    ),
    children,
  )
}

/** 键值字段。 */
function Field({ label, value }) {
  return h('div', { style: FIELD_STYLE },
    h('div', { style: LABEL_STYLE }, label),
    h('div', { style: VALUE_STYLE }, value),
  )
}

function Fields({ rows }) {
  return h('div', { style: ROWS_STYLE },
    ...rows.map((row, index) => h(Field, { key: index, label: row.label, value: row.value })),
  )
}

/** 工具失败时的红色提示。 */
function ErrorNote({ block }) {
  if (!block?.isError) return null
  const detail = block.error?.code !== undefined ? `${block.error.code}${block.error.name ? ` ${block.error.name}` : ''}` : '失败'
  return h('div', { style: { color: '#d1242f', marginTop: 6 } }, `工具执行${detail}，请查看日志重试。`)
}

/** 运行中占位。 */
function RunningNote() {
  return h('div', { style: NOTE_STYLE }, '运行中…')
}

/** tav2_status 卡片：项目总览。 */
function StatusCard({ block }) {
  if (block?.kind === 'tool-call') return h(Card, { title: 'tav2_status' }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined) return h(Card, { title: 'tav2_status' }, h(ErrorNote, { block }))
  const complianceBadge = meta.publicReleaseAllowed === true
    ? '已授权可公开发布'
    : meta.complianceAuthorized === true
      ? '已授权（本地）'
      : meta.complianceStatus
        ? meta.complianceStatus
        : '未记录'
  return h(Card, { title: 'tav2_status', badge: complianceBadge },
    h(Fields, { rows: [
      { label: '引擎', value: meta.engine || '—' },
      { label: '场景', value: `${meta.scenes ?? 0}` },
      { label: '单元', value: `${meta.units ?? 0}` },
      { label: '待译', value: `${meta.pendingUnits ?? 0}` },
      { label: '锁定术语', value: `${meta.lockedTerms ?? 0}` },
      { label: '待决术语', value: `${meta.pendingTerms ?? 0}` },
      { label: '世界书', value: `${meta.worldbookEntries ?? 0}` },
      { label: '待审批', value: `${meta.pendingApprovals ?? 0}` },
    ] }),
    meta.summary ? h('div', { style: NOTE_STYLE }, meta.summary) : null,
    h(ErrorNote, { block }),
  )
}

/** 覆盖率条。 */
function CoverageBar({ pct }) {
  const safe = Math.max(0, Math.min(100, Number(pct) || 0))
  return h('div', {
    style: { height: 8, borderRadius: 4, background: 'rgba(127,127,127,0.2)', overflow: 'hidden', margin: '6px 0' },
  }, h('div', { style: { width: `${safe}%`, height: '100%', background: '#2da44e' } }))
}

/** tav2_report 卡片：覆盖率 / 风险 / 审校队列 / 成本。 */
function ReportCard({ block }) {
  if (block?.kind === 'tool-call') return h(Card, { title: 'tav2_report' }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined) return h(Card, { title: 'tav2_report' }, h(ErrorNote, { block }))
  const pct = meta.coveragePct ?? 0
  return h(Card, { title: 'tav2_report', badge: `${pct}% 覆盖` },
    h(CoverageBar, { pct }),
    h(Fields, { rows: [
      { label: '已译单元', value: `${meta.translated ?? 0}` },
      { label: '待译', value: `${meta.pending ?? 0}` },
      { label: '待审校', value: `${meta.reviewQueue?.pendingApprovals ?? 0}` },
      { label: '待决术语', value: `${meta.risks?.pendingTerms ?? 0}` },
      { label: '低置信术语', value: `${meta.risks?.lowConfidenceTerms ?? 0}` },
      { label: '总 tokens', value: `${(meta.totalTokens ?? 0).toLocaleString()}` },
      { label: '运行次数', value: `${meta.runs ?? 0}` },
    ] }),
    meta.recentRuns?.length > 0
      ? h('div', { style: NOTE_STYLE }, `最近运行：${meta.recentRuns[meta.recentRuns.length - 1].kind} / ${meta.recentRuns[meta.recentRuns.length - 1].status}`)
      : null,
    h(ErrorNote, { block }),
  )
}

/** 计数类工具（terms/worldbook/deliberate/verify 摘要）通用卡片。 */
function CountCard({ title, rows, block }) {
  if (block?.kind === 'tool-call') return h(Card, { title }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined) return h(Card, { title }, h(ErrorNote, { block }))
  return h(Card, { title },
    h(Fields, { rows: rows.map((row) => ({ label: row.label, value: `${meta[row.key] ?? 0}` })) }),
    h(ErrorNote, { block }),
  )
}

function TermsCard(props) {
  return h(CountCard, {
    title: 'tav2_terms', block: props.block,
    rows: [
      { key: 'scanned', label: '扫描候选' },
      { key: 'seeded', label: '已入库' },
      { key: 'locked', label: '已锁定' },
    ],
  })
}

function WorldbookCard(props) {
  const block = props.block
  if (block?.kind === 'tool-call') return h(Card, { title: 'tav2_worldbook' }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined) return h(Card, { title: 'tav2_worldbook' }, h(ErrorNote, { block }))
  return h(Card, { title: 'tav2_worldbook' },
    h(Fields, { rows: [
      { label: '条目', value: `${meta.entries ?? 0}` },
      { label: '常驻', value: `${meta.constants ?? 0}` },
      { label: '引用文件', value: `${meta.filesReferenced ?? 0}` },
      { label: '文件覆盖', value: `${meta.fileCoverage ?? 0}%` },
    ] }),
    meta.warnings?.length > 0
      ? h('div', { style: { ...NOTE_STYLE, color: '#9a6700' } }, meta.warnings.join('\n'))
      : null,
    h(ErrorNote, { block }),
  )
}

function DeliberateCard(props) {
  return h(CountCard, {
    title: 'tav2_deliberate', block: props.block,
    rows: [
      { key: 'evaluated', label: '已推敲' },
      { key: 'auto_locked', label: '自动锁定' },
      { key: 'pending_approval', label: '待审批' },
      { key: 'failed', label: '失败' },
    ],
  })
}

function VerifyCard({ block }) {
  if (block?.kind === 'tool-call') return h(Card, { title: 'tav2_verify' }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined) return h(Card, { title: 'tav2_verify' }, h(ErrorNote, { block }))
  const format = meta.format ?? {}
  const ok = format.missingBlocks === 0 && (meta.missingUnits ?? 0) === 0
  return h(Card, { title: 'tav2_verify', badge: ok ? '校验通过' : '存在问题' },
    h(Fields, { rows: [
      { label: '缺失块', value: `${format.missingBlocks ?? 0}` },
      { label: '标签违规', value: `${format.tagViolations ?? 0}` },
      { label: '缺失单元', value: `${meta.missingUnits ?? 0}` },
      { label: '字体', value: meta.fonts?.found === true ? '已发现' : '未发现' },
    ] }),
    !ok ? h('div', { style: { color: '#d1242f', marginTop: 6 } }, '存在校验问题，未满足回写条件（missing_blocks=0）。') : null,
    h(ErrorNote, { block }),
  )
}

const JOB_STATUS_LABEL = {
  running: '运行中', stopping: '停止中', completed: '已完成',
  failed: '失败', killed: '已终止',
}
/** apply 时捕获的连接 api（设置卡读/写翻译模式用）。 */
let connectionApi = null

const MODE_NS = 'tav2'

const SCOPE_VALUES = ['main', 'all', 'experimental']
const SCOPE_LABELS = {
  main: 'main（仅主链路）',
  all: 'all（主链路+知识检索）',
  experimental: 'experimental（主链路+单批直跑）',
}
// 必须匹配 DSH 凭据引用语法（REF_PATTERN=/^[A-Za-z_][A-Za-z0-9_]*$/）：
// 旧值 'tav2:' 含冒号非法，credentials.set 会拒绝 → 填了密钥也存不进去。
const CHANNEL_KEY_PREFIX = 'TAV2_'
function channelKeyRef(name) { return CHANNEL_KEY_PREFIX + name }

/** 设置 → 插件 → dsh-plugin-tav2 卡片：自动识别 + 翻译渠道（宿主 token 样式）。
 *  渠道=名称/接口地址/模型/覆盖范围 + 密钥（存宿主凭据域，ref=TAV2_<渠道名>）；当前渠道快速切换。 */
function TranslationApiCard() {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [available, setAvailable] = React.useState(true)
  const [writable, setWritable] = React.useState(true)
  const [channels, setChannels] = React.useState([])   // [{name, baseUrl, model, scope}]
  const [active, setActive] = React.useState('')        // 当前渠道名；''=宿主
  const [renpySdk, setRenpySdk] = React.useState('')    // Ren'Py SDK 路径（覆盖插件 yaml 层）
  const [expanded, setExpanded] = React.useState({})    // 渠道盒子折叠状态（默认收起）
  const [base, setBase] = React.useState(null)          // 上次保存快照（判断脏）
  const [keyDrafts, setKeyDrafts] = React.useState({})  // 渠道名 -> 密钥输入
  const [configured, setConfigured] = React.useState({})// ref -> 已配置
  const [saving, setSaving] = React.useState(false)
  const [saveFailed, setSaveFailed] = React.useState(false)

  const refresh = async () => {
    if (connectionApi === null) {
      setLoading(false)
      setAvailable(false)
      setError('连接服务不可用，请重试。')
      return
    }
    try {
      const response = await connectionApi.settings.describe({})
      const ns = (response.result?.value?.namespaces ?? []).find((item) => item.ns === MODE_NS)
      setWritable(response.result?.value?.writable ?? true)
      setAvailable(ns !== undefined)
      if (!ns) {
        setLoading(false)
        setError(null)
        return
      }
      const list = Array.isArray(ns.value?.translationChannels) ? ns.value.translationChannels : []
      const clean = list
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          name: typeof c.name === 'string' ? c.name : '',
          baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
          model: typeof c.model === 'string' ? c.model : '',
          scope: SCOPE_VALUES.includes(c.scope) ? c.scope : 'main',
        }))
      const activeVal = typeof ns.value?.translationActiveChannel === 'string'
        ? ns.value.translationActiveChannel : ''
      const sdkVal = typeof ns.value?.renpySdk === 'string' ? ns.value.renpySdk : ''
      setChannels(clean)
      setActive(activeVal)
      setRenpySdk(sdkVal)
      setExpanded({})
      setBase(JSON.stringify({ channels: clean, active: activeVal, renpySdk: sdkVal }))
      setKeyDrafts({})
      setConfigured({})
      // 各渠道密钥状态：ref=TAV2_<渠道名>（与 dsh 主密钥同一套凭据域）
      const refs = clean.map((c) => channelKeyRef(c.name))
      try {
        const credRes = await connectionApi.credentials.describe({ refs })
        const creds = credRes.result?.value?.credentials ?? {}
        const cfg = {}
        for (const r of refs) cfg[r] = Boolean(creds[r]?.configured)
        setConfigured(cfg)
      } catch {
        // 凭据服务不可用：密钥状态未知，不影响主流程
      }
      setLoading(false)
      setError(null)
    } catch (err) {
      setLoading(false)
      setError(`读取状态失败：${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    }
  }

  React.useEffect(() => { void refresh() }, [])

  const keyDirty = Object.values(keyDrafts).some((k) => typeof k === 'string' && k.trim() !== '')
  const dirty = !base || JSON.stringify({ channels, active, renpySdk }) !== base || keyDirty
  // 校验：名称非空且不重复、接口地址必填
  const nameSet = new Set()
  const invalidRows = []
  channels.forEach((c, i) => {
    const name = (c.name || '').trim()
    const ok = name !== '' && !nameSet.has(name) && (c.baseUrl || '').trim() !== ''
    if (!ok) invalidRows.push(i)
    if (name) nameSet.add(name)
  })

  const editChannel = (index, field, value) => {
    setChannels((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)))
  }

  const addChannel = () => {
    const idx = channels.length
    setChannels((prev) => [...prev, { name: '', baseUrl: '', model: '', scope: 'main' }])
    // 新渠道默认展开，便于直接填写
    setExpanded((prev) => ({ ...prev, [idx]: true }))
  }

  const removeChannel = (index) => {
    setChannels((prev) => prev.filter((_, i) => i !== index))
  }

  const save = async () => {
    if (connectionApi === null) return
    if (invalidRows.length > 0) {
      setError('请先修正渠道：名称非空且不重复、接口地址必填。')
      return
    }
    setSaving(true)
    setSaveFailed(false)
    setError(null)
    try {
      const clean = channels.map((c) => ({
        name: c.name.trim(),
        baseUrl: c.baseUrl.trim(),
        model: (c.model || '').trim(),
        scope: SCOPE_VALUES.includes(c.scope) ? c.scope : 'main',
      }))
      await connectionApi.settings.update({
        ns: MODE_NS,
        patch: { translationChannels: clean, translationActiveChannel: active, renpySdk: (renpySdk || '').trim() },
      })
      // 写各渠道密钥到宿主凭据域（ref=TAV2_<渠道名>，与 dsh 主密钥同一套存储）
      for (const c of clean) {
        const text = (keyDrafts[c.name] || '').trim()
        if (text) await connectionApi.credentials.set({ ref: channelKeyRef(c.name), value: text })
      }
      await refresh()
    } catch (err) {
      setSaveFailed(true)
      setError(`保存失败：${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    } finally {
      setSaving(false)
    }
  }

  const discard = () => { void refresh() }

  if (loading) return h('div', { className: 'tv2-card', style: { padding: '14px 16px' } }, '加载中…')
  if (!available) {
    return h('div', { className: 'tv2-card', style: { padding: '14px 16px' } }, '命名空间 tav2 不可用，请重启插件后重试。')
  }

  const header = h('button', {
    type: 'button',
    className: 'tv2-header',
    'aria-expanded': open,
    onClick: () => setOpen(!open),
  },
    h('span', { className: 'tv2-headText' },
      h('span', { className: 'tv2-name' }, 'dsh-plugin-tav2'),
      h('span', { className: 'tv2-description' }, '翻译渠道 · Ren\'Py SDK（初始化引导见会话）')),
    dirty ? h('span', { className: 'tv2-pending' }, '未保存') : null,
    h('span', { className: open ? 'tv2-chevron tv2-chevronOpen' : 'tv2-chevron' }, '▾'),
  )

  const modeRow = null // 自动识别开关已移除：安装改为按工作区自动分级（游戏区全套/普通区引导包）

  // 插件依赖：Ren'Py SDK 路径（.rpyc 编译游戏 prepare 需要；覆盖插件 yaml 的 renpySdk）
  const sdkField = h('div', { className: 'tv2-field' },
    h('div', { className: 'tv2-head' },
      h('label', { htmlFor: 'tav2-renpySdk', className: 'tv2-label' }, 'Ren\'Py SDK 路径'),
      h('span', { className: 'tv2-hint' }, renpySdk ? '已配置（覆盖插件 yaml）' : '未配置（仅 .rpyc 编译游戏需要）')),
    h('input', {
      id: 'tav2-renpySdk',
      type: 'text',
      autoComplete: 'off',
      className: 'tv2-input',
      value: renpySdk,
      disabled: !writable,
      placeholder: '如 D:/renpy-8.5.3-sdk',
      onChange: (event) => setRenpySdk(event.target.value),
    }),
    h('p', { className: 'tv2-hint' }, '只有游戏脚本是已编译 .rpyc 时需要。留空时 tav2_prepare 会提示你在这里配置。'))

  // 当前渠道选择器：''=宿主（dsh 主密钥/ctx.llm）
  const activeSelect = h('div', { className: 'tv2-field' },
    h('div', { className: 'tv2-head' },
      h('label', { htmlFor: 'tav2-activeChannel', className: 'tv2-label' }, '当前渠道'),
      h('span', { className: 'tv2-hint' }, active === '' ? '翻译走宿主（dsh 主密钥）' : `翻译走渠道「${active}」`)),
    h('select', {
      id: 'tav2-activeChannel',
      className: 'tv2-input',
      value: active,
      disabled: !writable,
      onChange: (event) => setActive(event.target.value),
    }, [
      h('option', { key: '', value: '' }, '宿主（默认）'),
      ...channels.map((c) => h('option', { key: c.name, value: c.name }, c.name)),
    ]),
  )

  // 渠道行：每个渠道一个可折叠盒子（默认收起；展开显示名称/接口地址/模型/范围 + 密钥）
  const channelRows = channels.map((c, i) => {
    const invalid = invalidRows.includes(i)
    const ref = channelKeyRef(c.name)
    const isExpanded = Boolean(expanded[i])
    const boxCls = invalid ? 'tv2-channelBox tv2-channelBoxInvalid' : 'tv2-channelBox'
    return h('div', { key: i, className: boxCls },
      h('div', { className: 'tv2-channelHead' },
        h('button', {
          type: 'button',
          className: 'tv2-reset',
          'aria-expanded': isExpanded,
          style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' },
          onClick: () => setExpanded((prev) => ({ ...prev, [i]: !prev[i] })),
        },
          h('span', { className: 'tv2-label' }, `渠道 ${i + 1}：${c.name || '（未命名）'}`),
          h('span', { className: configured[ref] ? 'tv2-badge' : 'tv2-badgeMuted' }, configured[ref] ? '密钥已配置' : '密钥未配置'),
          h('span', { className: isExpanded ? 'tv2-chevron tv2-chevronOpen' : 'tv2-chevron' }, '▸')),
        h('button', { type: 'button', className: 'tv2-reset', disabled: !writable, onClick: () => removeChannel(i) }, '删除')),
      isExpanded ? h(React.Fragment, null,
        h('div', { className: 'tv2-grid' },
          h('div', { className: 'tv2-cell' },
            h('label', { htmlFor: `tav2-name-${i}`, className: 'tv2-label' }, '名称'),
            h('input', { id: `tav2-name-${i}`, type: 'text', className: 'tv2-input', value: c.name, disabled: !writable,
              placeholder: '如：火山 / 本地', onChange: (e) => editChannel(i, 'name', e.target.value) })),
          h('div', { className: 'tv2-cell' },
            h('label', { htmlFor: `tav2-baseUrl-${i}`, className: 'tv2-label' }, '接口地址'),
            h('input', { id: `tav2-baseUrl-${i}`, type: 'text', className: 'tv2-input', value: c.baseUrl, disabled: !writable,
              placeholder: 'https://api.example.com/v1', onChange: (e) => editChannel(i, 'baseUrl', e.target.value) })),
          h('div', { className: 'tv2-cell' },
            h('label', { htmlFor: `tav2-model-${i}`, className: 'tv2-label' }, '模型（可选）'),
            h('input', { id: `tav2-model-${i}`, type: 'text', className: 'tv2-input', value: c.model, disabled: !writable,
              placeholder: '留空=用 config.yaml 的 llm.model', onChange: (e) => editChannel(i, 'model', e.target.value) })),
          h('div', { className: 'tv2-cell' },
            h('label', { htmlFor: `tav2-scope-${i}`, className: 'tv2-label' }, '覆盖范围'),
            h('select', { id: `tav2-scope-${i}`, className: 'tv2-input', value: c.scope, disabled: !writable,
              onChange: (e) => editChannel(i, 'scope', e.target.value) },
              SCOPE_VALUES.map((s) => h('option', { key: s, value: s }, SCOPE_LABELS[s])))),
        ),
        h('div', { className: 'tv2-cell' },
          h('label', { htmlFor: `tav2-key-${i}`, className: 'tv2-label' }, 'API 密钥'),
          h('input', {
            id: `tav2-key-${i}`,
            type: 'password',
            autoComplete: 'off',
            className: 'tv2-input',
            value: keyDrafts[c.name] || '',
            disabled: !writable,
            placeholder: configured[ref] ? '已保存（留空不改）' : '',
            onChange: (event) => setKeyDrafts((prev) => ({ ...prev, [c.name]: event.target.value })),
          })),
        invalid ? h('p', { className: 'tv2-invalid' }, '名称非空且不重复、接口地址必填') : null,
      ) : null,
    )
  })

  const footer = h('div', { className: 'tv2-footer' },
    saveFailed ? h('p', { className: 'tv2-failed' }, '保存失败') : null,
    h('button', { type: 'button', className: 'tv2-discard', disabled: !dirty || saving, onClick: discard }, '放弃修改'),
    h('button', {
      type: 'button',
      className: 'tv2-save',
      disabled: !dirty || invalidRows.length > 0 || saving || !writable,
      onClick: () => void save(),
    }, saving ? '保存中…' : '保存'))

  return h('div', { className: open ? 'tv2-card tv2-cardOpen' : 'tv2-card' },
    header,
    open ? h('div', { className: 'tv2-body' },
      !writable ? h('p', { className: 'tv2-hint', style: { marginTop: 12 } }, '当前配置只读，无法修改。') : null,
      h('div', { className: 'tv2-sectionTitle' }, '初始化引导'),
      h('p', { className: 'tv2-sectionHint' }, '不用手动开任何开关：在包含游戏的工作区里对助手说「初始化游戏翻译」，助手会自动识别游戏（可能有多个，会问你选哪个）、生成 config.yaml 并配置好工具。'),
      h('div', { className: 'tv2-sectionTitle' }, '插件依赖'),
      h('p', { className: 'tv2-sectionHint' }, '翻译遇到需要外部依赖（如 .rpyc 编译游戏要 Ren\'Py SDK、运行时缺 CJK 字体）时，助手会提醒你到这里配置路径。'),
      sdkField,
      h('div', { className: 'tv2-sectionTitle' }, '翻译渠道'),
      h('p', { className: 'tv2-sectionHint' }, '选「宿主」=翻译走 dsh 主密钥/ctx.llm（默认，行为不变）；选渠道=走该渠道的接口/模型/密钥。密钥存在 dsh 凭据域（和 dsh 主密钥同一套），保存后跨会话保留。'),
      activeSelect,
      channelRows.length > 0 ? channelRows : h('p', { className: 'tv2-hint' }, '还没有渠道。点「添加渠道」配置一个（如火山方舟、OpenAI 兼容、本地模型）。'),
      h('button', { type: 'button', className: 'tv2-add', disabled: !writable, onClick: addChannel }, '＋ 添加渠道'),
      error ? h('p', { className: 'tv2-error' }, error) : null,
      footer,
    ) : null,
  )
}


/** 后台任务卡片（prepare / translate_batch / review_backfill）：meta 提供 jobId，实时状态读 jobs 镜像。 */
function JobCard({ block, sessionId, useSessions }) {
  if (block?.kind === 'tool-call') return h(Card, { title: 'tav2 后台任务' }, h(RunningNote, null))
  const meta = metaOf(block)
  if (meta === undefined || !meta.jobId) return h(Card, { title: 'tav2 后台任务' }, h(ErrorNote, { block }))
  const jobs = useSessions(state => state.jobsBySession?.[sessionId]) ?? []
  const job = jobs.find(entry => entry.id === meta.jobId)
  if (job === undefined) {
    return h(Card, { title: meta.label || 'tav2 后台任务' },
      h('div', null, '任务已启动，等待注册表状态…'),
    )
  }
  const stats = parseJobDetail(job.detail)
  const ratioRows = [['units', '单元'], ['scenes', '场景'], ['batches', '批次']]
    .filter(([key]) => stats[key] !== undefined)
    .map(([key, label]) => ({ label, value: `${stats[key].done}/${stats[key].total}` }))
  const plainRows = [['tokens', 'tokens'], ['retries', '重试'], ['applied', '回填'], ['skipped', '跳过']]
    .filter(([key]) => stats[key] !== undefined)
    .map(([key, label]) => ({ label, value: `${stats[key]}` }))
  return h(Card, {
    title: meta.label || 'tav2 后台任务',
    badge: JOB_STATUS_LABEL[job.status] ?? job.status,
  },
    h(Fields, { rows: [...ratioRows, ...plainRows] }),
    h('div', { style: NOTE_STYLE }, `任务 ${job.id}`),
  )
}

/** 客户端插件体：注册各 tav2_* 工具的 keyed 对话卡片。 */
export const inject = ['slots', 'connection']

export function apply(ctx) {
  connectionApi = ctx.get('connection')?.api ?? null
  const register = (key, Component) => {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      Component,
    ))
  }
  register('tav2_status', StatusCard)
  register('tav2_report', ReportCard)
  register('tav2_terms', TermsCard)
  register('tav2_worldbook', WorldbookCard)
  register('tav2_deliberate', DeliberateCard)
  register('tav2_verify', VerifyCard)
  register('tav2_prepare', JobCard)
  register('tav2_translate_batch', JobCard)
  register('tav2_review_backfill', JobCard)

  // /tav2-mode 命令不注册自定义 commandview：宿主对未注册命令自动渲染
  // GenericCommandCard（状态点 + 可展开结果），与所有命令一致。
  // 插件配置卡片（设置 → 插件 → 可配置插件 → dsh-plugin-tav2）：
  // 初始化引导提示 + 插件依赖（Ren'Py SDK 路径）+ 翻译渠道（当前渠道选择器
  // + 可折叠渠道列表：名称/接口地址/模型/范围 + 密钥）。
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MODE_NS,
    order: 5,
    label: () => 'dsh-plugin-tav2',
  }, TranslationApiCard))
}
