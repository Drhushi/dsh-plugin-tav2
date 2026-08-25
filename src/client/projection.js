/**
 * 翻译面板投影层纯 helper（浏览器端，无 DOM/React 依赖，可离线单测）：
 * - lastToolMeta：从会话节点里取某工具最近一次结果的 presentationMeta；
 * - parseJobDetail：解析后台任务 detail 文本（翻译统计串 / 回填统计串）；
 * - isTav2Job / isTranslatorTrace：翻译任务与会话识别。
 */

/**
 * 取最近一次工具结果的 meta（按 seq 取最后出现的 tool-result 节点）。
 * @param {readonly any[] | null | undefined} nodes - 会话节点数组（ToolResultNode 纯数据子集即可）。
 * @param {string} toolName - wire 工具名。
 * @returns {unknown | undefined} 最近一次结果的 presentationMeta，未出现返回 undefined。
 */
export function lastToolMeta(nodes, toolName) {
  if (!Array.isArray(nodes)) return undefined
  let latest = undefined
  let latestSeq = -1
  for (const node of nodes) {
    if (node?.kind !== 'tool-result') continue
    if (node.call?.name !== toolName) continue
    if (node.meta === undefined || node.meta === null) continue
    const seq = typeof node.seq === 'number' ? node.seq : 0
    if (seq >= latestSeq) {
      latestSeq = seq
      latest = node.meta
    }
  }
  return latest
}

/**
 * 解析后台任务 detail 文本为结构化统计。
 * 翻译任务串形如 "units: 12/30 scenes: 2/5 batches: 3/8 tokens: 183420 retries: 1"；
 * 回填任务串形如 "applied=5 skipped=0 db_synced=1"。
 * @param {string | null | undefined} text - 任务 detail。
 * @returns {Record<string, unknown>} 解析结果；无法识别返回空对象。
 */
export function parseJobDetail(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  const stats = {}
  const collect = (regex, toValue) => {
    let match
    regex.lastIndex = 0
    while ((match = regex.exec(text)) !== null) {
      stats[match[1]] = toValue(match)
    }
  }
  collect(/([a-z_]+):\s*(\d+)\s*\/\s*(\d+)/g, (m) => ({ done: Number(m[2]), total: Number(m[3]) }))
  // 普通数字不得是比值（"units: 12/30" 只归比值规则，避免回溯后把 12 拆成 1 覆盖）。
  collect(/([a-z_]+):\s*(\d+)(?!\s*[\d/])/g, (m) => Number(m[2]))
  collect(/([a-z_]+)=(\d+)/g, (m) => Number(m[2]))
  return stats
}

/**
 * 任务标签是否为 tav2 翻译任务。
 * @param {unknown} label - 任务标签。
 * @returns {boolean}
 */
export function isTav2Job(label) {
  return typeof label === 'string' && label.startsWith('tav2')
}

/**
 * 会话节点里是否出现过 tav2_* 工具调用（翻译会话识别）。
 * @param {readonly any[] | null | undefined} nodes - 会话节点数组。
 * @returns {boolean}
 */
export function isTranslatorTrace(nodes) {
  if (!Array.isArray(nodes)) return false
  return nodes.some((node) => (
    node?.kind === 'tool-result'
    && typeof node.call?.name === 'string'
    && node.call.name.startsWith('tav2_')
  ))
}
