/**
 * 设置卡远程数据面：把宿主 Remote 调用收敛成纯函数，供设置卡（src/client/index.js）
 * 调用，并可在离线测试里用契约夹具驱动（不 import React、不碰 DOM）。
 *
 * 契约（dsh 0.1.5 起）：
 *   - 远程命名空间挂在 cordis 服务 `remote.<namespace>` 上（`ctx.get('remote.settings')`），
 *     旧版的 `ctx.get('connection').api.settings` 已随 dsh 升级移除；
 *   - 每次调用返回信封 `{ ok: true, value } | { ok: false, error: { code, message } }`；
 *   - 方法签名按宿主参数表严格校验实参个数：`settings.describe()`（零参）、
 *     `settings.update(ns, patch, expectedRevision)`（三参）、
 *     `credentials.describe(refs: string[])`、`credentials.set(ref, value)`。
 * 本模块只做形状适配与错误归一，不做旧版双通道兼容（fail-closed）。
 */

/** 设置命名空间服务名（cordis 点号服务：ctx.remote.settings）。 */
const SETTINGS_SERVICE = 'remote.settings'
/** 凭据命名空间服务名。 */
const CREDENTIALS_SERVICE = 'remote.credentials'

/** 渠道覆盖范围取值（与宿主 tav2SettingsSchema 的 scope 枚举一致）。 */
export const SCOPE_VALUES = ['main', 'all', 'experimental']

/** 设置通道缺失时的降级文案（卡片直接展示）。 */
export const SETTINGS_UNAVAILABLE_MESSAGE =
  '设置通道不可用：当前 dsh 未提供 remote.settings 服务（需要 dsh ≥ 0.1.5 的 Remote 设置通道）。'
  + '更新 dsh 后重启 harness 再打开本卡片。'

/** 凭据通道缺失时的降级文案。 */
export const CREDENTIALS_UNAVAILABLE_MESSAGE =
  '凭据通道不可用：当前 dsh 未提供 remote.credentials 服务（需要 dsh ≥ 0.1.5 的 Remote 凭据通道）。'

/** 通道通、但 tav2 命名空间没注册（服务端半未加载/注册失败）时的文案。 */
export const NAMESPACE_MISSING_MESSAGE =
  '命名空间 tav2 未注册：插件的服务端半未加载或注册失败（见 harness 日志的 [dsh-plugin-tav2] 行），重启 harness 后重试。'

/** 失败结果的统一形状（供卡片取 code/message 显示）。 */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/** 任意抛错 → 单行文本（截断，避免把整页堆栈塞进卡片）。 */
function messageOf(err) {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, 200)
}

/**
 * 解析一个 cordis 点号服务：优先 `ctx.get(name)`（不要求 inject），
 * 失败或为空时退化为按点号逐层属性访问（`ctx.remote.settings`）。
 * 两条路径都抛错/缺失时返回 undefined——调用方据此给出降级文案。
 */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const found = ctx.get(name)
      if (found !== undefined && found !== null) return found
    } catch {
      // 缺 inject 时属性访问器会抛错；继续尝试属性路径
    }
  }
  try {
    let node = ctx
    for (const key of name.split('.')) {
      if (node === null || node === undefined) return undefined
      node = node[key]
    }
    return node ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 解析客户端插件上下文里的设置/凭据远程面。
 * @returns {{settings?: unknown, credentials?: unknown, missing: string[]}}
 */
export function remoteFacesOf(ctx) {
  const settings = serviceOf(ctx, SETTINGS_SERVICE)
  const credentials = serviceOf(ctx, CREDENTIALS_SERVICE)
  const missing = []
  if (settings === undefined) missing.push(SETTINGS_SERVICE)
  if (credentials === undefined) missing.push(CREDENTIALS_SERVICE)
  return { settings, credentials, missing }
}

/**
 * 解宿主 Remote 结果信封。
 * @returns {{ok: true, value: unknown} | {ok: false, error: {code: string, message: string}}}
 */
export function unwrapRemote(response) {
  if (response === null || response === undefined || typeof response !== 'object') {
    return failure('no-response', '设置通道无响应（Remote 调用未返回结果）。')
  }
  if (typeof response.ok !== 'boolean') {
    return failure(
      'unexpected-response',
      '设置通道返回了非 Remote 信封结构（需要 dsh ≥ 0.1.5 的 {ok,value} 契约）。',
    )
  }
  if (response.ok !== true) {
    const error = response.error ?? {}
    return failure(
      typeof error.code === 'string' ? error.code : 'remote-error',
      typeof error.message === 'string' ? error.message : 'Remote 调用失败',
    )
  }
  return { ok: true, value: response.value }
}

/**
 * 读全部设置命名空间视图（一次 RPC）：`settings.describe()`。
 * @returns {{ok: boolean, value?: {writable?: unknown, namespaces?: unknown[]}, error?: object}}
 */
export async function readSettingsDescribe(settings) {
  if (settings === null || settings === undefined || typeof settings.describe !== 'function') {
    return failure('unavailable', SETTINGS_UNAVAILABLE_MESSAGE)
  }
  try {
    // dsh 0.1.5：describe 不接受任何实参（多传即被宿主参数表拒绝）
    return unwrapRemote(await settings.describe())
  } catch (err) {
    return failure('call-failed', messageOf(err))
  }
}

/**
 * 从 describe 视图里取某个命名空间的行。 */
export function namespaceRowOf(describeValue, ns) {
  const rows = Array.isArray(describeValue?.namespaces) ? describeValue.namespaces : []
  return rows.find((row) => row?.ns === ns)
}

/**
 * 卡片降级文案决策：能用 → null（正常渲染表单）；不能用 → 说清是哪一类问题
 * （通道缺失 / 读失败 / 命名空间未注册），避免旧版把三类问题混成一句
 * 「命名空间 tav2 不可用」误导排查。
 * @param faces - remoteFacesOf 的结果
 * @param described - readSettingsDescribe 的结果（通道缺失时为 undefined）
 * @param nsRow - namespaceRowOf 取到的行（未注册/读失败时为 undefined）
 * @returns 降级文案，或 null 表示可正常渲染。
 */
export function cardFatalMessage(faces, described, nsRow) {
  if (faces?.settings === undefined) return SETTINGS_UNAVAILABLE_MESSAGE
  if (described === undefined || described === null || described.ok !== true) {
    return `读取设置失败：${described?.error?.message ?? 'Remote 未返回结果'}`
  }
  if (nsRow === undefined || nsRow === null) return NAMESPACE_MISSING_MESSAGE
  return null
}

/**
 * 命名空间行 → 卡片表单模型（渠道列表 + 当前渠道 + Ren'Py SDK + revision）。
 * 缺字段一律回落空值/默认值，畸形输入不抛错。
 */
export function cardModelOf(row) {
  const list = Array.isArray(row?.value?.translationChannels) ? row.value.translationChannels : []
  const channels = list
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      name: typeof c.name === 'string' ? c.name : '',
      baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
      model: typeof c.model === 'string' ? c.model : '',
      scope: SCOPE_VALUES.includes(c.scope) ? c.scope : 'main',
    }))
  return {
    channels,
    active: typeof row?.value?.translationActiveChannel === 'string' ? row.value.translationActiveChannel : '',
    renpySdk: typeof row?.value?.renpySdk === 'string' ? row.value.renpySdk : '',
    revision: typeof row?.revision === 'number' ? row.revision : undefined,
  }
}

/** 渠道名 → 宿主凭据域引用名（必须匹配 /^[A-Za-z_][A-Za-z0-9_]*$/）。 */
export function channelRefOf(name) {
  return `TAV2_${name}`
}

/**
 * 保存前校验一个渠道行。
 * @returns 错误文案，合法时 null。
 */
export function channelProblem(channel, existingNames) {
  const name = (channel?.name ?? '').trim()
  if (name === '') return '渠道名称不能为空'
  if ((existingNames ?? []).includes(name)) return '渠道名称重复'
  // 凭据引用名是 TAV2_<渠道名>，含非标识符字符时宿主的 credentials.set 会拒绝
  if (!/^[A-Za-z0-9_]+$/.test(name)) return '渠道名称只能用字母、数字、下划线（密钥引用名 TAV2_<名称> 的合法性要求）'
  if ((channel?.baseUrl ?? '').trim() === '') return '接口地址必填'
  return null
}

/** 卡片校验：返回不合法行的下标列表（组件据此禁用保存按钮）。 */
export function invalidChannelRows(channels) {
  const seen = new Set()
  const invalid = []
  ;(Array.isArray(channels) ? channels : []).forEach((channel, index) => {
    const name = (channel?.name ?? '').trim()
    const problem = channelProblem(channel, [...seen])
    if (problem !== null) invalid.push(index)
    if (name !== '') seen.add(name)
  })
  return invalid
}

/**
 * 读各渠道密钥配置状态：`credentials.describe(refs: string[])`。
 * @returns {{ok: boolean, states: Record<string, boolean>, error?: object}}
 */
export async function readCredentialStates(credentials, refs) {
  const list = Array.isArray(refs) ? refs.filter((ref) => typeof ref === 'string' && ref !== '') : []
  if (list.length === 0) return { ok: true, states: {} }
  if (credentials === null || credentials === undefined || typeof credentials.describe !== 'function') {
    return { ...failure('unavailable', CREDENTIALS_UNAVAILABLE_MESSAGE), states: {} }
  }
  try {
    const unwrapped = unwrapRemote(await credentials.describe(list))
    if (!unwrapped.ok) return { ...unwrapped, states: {} }
    const record = unwrapped.value ?? {}
    const states = {}
    for (const ref of list) states[ref] = Boolean(record?.[ref]?.configured)
    return { ok: true, states }
  } catch (err) {
    return { ...failure('call-failed', messageOf(err)), states: {} }
  }
}

/**
 * 保存渠道设置：`settings.update(ns, patch, expectedRevision)`（第三参必须显式传，
 * 可为 undefined；传读到的 revision 可让宿主做并发冲突检测）。
 * @returns {{ok: boolean, conflict: boolean, value?: unknown, error?: object}}
 */
export async function writeCardSettings(settings, ns, patch, revision) {
  if (settings === null || settings === undefined || typeof settings.update !== 'function') {
    return { ...failure('unavailable', SETTINGS_UNAVAILABLE_MESSAGE), conflict: false }
  }
  try {
    const unwrapped = unwrapRemote(await settings.update(ns, patch, revision))
    if (!unwrapped.ok) {
      return { ...unwrapped, conflict: unwrapped.error?.code === 'settings/conflict' }
    }
    return { ok: true, conflict: false, value: unwrapped.value }
  } catch (err) {
    return { ...failure('call-failed', messageOf(err)), conflict: false }
  }
}

/**
 * 写密钥草稿：逐条 `credentials.set(ref, value)`，只写非空草稿，失败聚合返回。
 * @param drafts - [{ref, value}]
 * @returns {{ok: boolean, failures: Array<{ref: string, message: string}>}}
 */
export async function writeCredentialDrafts(credentials, drafts) {
  const list = (Array.isArray(drafts) ? drafts : []).filter(
    (draft) => typeof draft?.value === 'string' && draft.value.trim() !== '',
  )
  if (list.length === 0) return { ok: true, failures: [] }
  if (credentials === null || credentials === undefined || typeof credentials.set !== 'function') {
    return { ok: false, failures: list.map((draft) => ({ ref: draft.ref, message: CREDENTIALS_UNAVAILABLE_MESSAGE })) }
  }
  const failures = []
  for (const draft of list) {
    try {
      const unwrapped = unwrapRemote(await credentials.set(draft.ref, draft.value.trim()))
      if (!unwrapped.ok) failures.push({ ref: draft.ref, message: unwrapped.error.message })
    } catch (err) {
      failures.push({ ref: draft.ref, message: messageOf(err) })
    }
  }
  return { ok: failures.length === 0, failures }
}
