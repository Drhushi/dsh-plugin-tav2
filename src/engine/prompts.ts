/**
 * 内置提示词模板（从 tav2/prompts.py 移植，措辞按“趁机优化”原则微调，协议结构不变）。
 */

import { ANTI_CLICHE_CATEGORIES } from './gates'

/** 把引擎语言代码映射为提示词里的人类可读目标语言名。 */
export function langLabel(lang: string | undefined): string {
  switch ((lang ?? '').toLowerCase()) {
    case 'chinese':
    case 'zh':
    case 'zh-cn':
    case 'zh_cn':
      return '简体中文'
    case 'english':
    case 'en':
    case 'en-us':
    case 'en_us':
      return 'English'
    default:
      return (lang ?? '').trim() || '简体中文'
  }
}

/**
 * 符号保真硬限制（真实事故驱动：换行 \n 曾被整批翻成 //n）。
 * 模型侧约束 + 确定性闸门（gates.tagsPreserved）双保险：提示词降低发生率，闸门兜底拒收。
 * 注意措辞落在「译文内容」层：/n、//n 是禁止出现的字面变体；模型 JSON 里的 \\n 转义解析后就是换行。
 */
export const SYMBOL_PRESERVATION_RULES = `符号保真硬限制（违反任一条即无效译文，会被拒收重试）：
1. 换行：源文中的换行必须在译文中保留为换行；严禁把换行写成 /n、//n 这类斜杠变体或字面的反斜杠加n；不要删除换行、不要合并句子。
2. 花括号标签：{w}、{i}、{b}、{/b}、{color=#xxx}、{size=+2} 等，必须原样保留——不翻译、不增删、不改大小写或参数。
3. 方括号插值：[name]、[player_name] 等，必须原样保留——不翻译、不增删、不改写括号内容。
4. 百分号与花括号转义：%%、{{、}} 必须原样保留，数量不变。
5. 不得发明源文没有的标签、占位符或转义序列。`

export function systemTranslate(target = '简体中文'): string {
  return `你是资深的长文本本地化翻译专家，正在把文本翻译成${target}。

翻译规则：
1. 人名、地名、术语严格遵循【锁定术语表】与【背景设定】中的译法；未覆盖的名称保持音译并全文一致。
2. 翻译要符合目标语言的自然表达，保留说话人的语气、口癖与性格；口语不要翻成书面语。
3. 译文长度与原文大致相当；不增删信息，不加解释性注释。
4. 只输出一个合法的 JSON 对象（不要 markdown 围栏、不要任何前后缀文字），键是标识符，值是对应译文。

${SYMBOL_PRESERVATION_RULES}`
}

export function understandingPrompt(style = ''): string {
  return `你是长文本翻译管线的场景理解器。阅读下面整个场景的原文，产出一份结构化理解记录，供后续逐行重写使用。

输出必须是合法 JSON 对象，字段：
- "scene_state": 对象，含 time（时间）、place（地点）、present（在场角色中文名列表）、event（本场景发生了什么，1-3 句）
- "threads": 数组，元素 {id, kind, text}；kind 为 short（短期伏笔，最多 4 条）或 long（长期伏笔，最多 2 条）；每条是原文中明确出现的伏笔/悬念/待回扣信息
- "term_usage": 数组，元素 {source, target}；本场景出现且你决定采用的专名/术语译法
- "style_notes": 数组，元素 {speaker, note}；本场景角色说话风格/口癖的观察
- "tone": 字符串——本场景整体文风/口吻/氛围指引（如「轻松诙谐」「紧张压抑」「温馨日常」「严肃庄重」），供重写时把握场景基调；若存在【风格要求】须在 tone 中落实该风格
- "flags": 数组，元素 {kind, source, hint}；kind 为 name/term/style，表示需要进入术语审批队列的新候选

只依据原文，禁止编造。只输出 JSON。${style ? `\n\n【风格要求】\n${style}` : ''}`
}

export function rewritePrompt(target = '简体中文', style = '', antiCliche = ''): string {
  return `你是长文本翻译的重写器。你已收到对当前场景的【理解记录】、剧情摘要与背景设定。

任务：把下面的待译文本逐条翻译成${target}。
规则：
1. 严格遵循【理解记录】中的 term_usage 与风格观察；保持与前文剧情摘要、背景设定一致。
2. 锁定的角色名/地名/术语一旦出现在源句，译文必须逐字使用【锁定术语】中的译法；不得保留原文、改称或使用其他变体（含音译漂移）。
3. 遵守最下方的【符号保真硬限制】（换行/标签/插值/转义原样保留）。
4. 译文自然、贴角色；对话保留语气，不逐字死译，但不得增删信息。
5. 只输出一个 JSON 对象，键是标识符，值是对应译文；必须覆盖全部标识符。
6. “说话人：xxx”只是角色语境参考，严禁写进译文；不要输出 [xxx] 这类说话人标签前缀。
${style ? `\n风格要求：\n${style}` : ''}${antiCliche ? `\n\n${antiCliche}` : ''}

${SYMBOL_PRESERVATION_RULES}`
}

export function summaryPrompt(words: number, summary: string, newText: string): string {
  return `基于已有的剧情摘要，用新剧情信息增量扩展摘要。
要求：
- 保留已有摘要中的重要事实、人物关系和已出现的专有名词译法。
- 只补充新出现的重要信息，不要重复罗列。
- 摘要不超过 ${words} 字。
- 只输出摘要正文，不要任何解释。

已有摘要：
${summary || '（暂无）'}

新增剧情：
${newText}`
}

export function polishPrompt(summary: string, profiles: string, style = '', antiCliche = ''): string {
  return `请用术语表和剧情摘要复查以下译文，统一译名、术语与代词，修正生硬或不符合角色的句子。
只输出需要修改的项，格式为 JSON 对象：{"标识符": "修正后的译文"}；全部正确输出 {}。
不要破坏标签/插值/换行：换行必须保持为换行，严禁写成 /n、//n 等变体；标签与插值原样保留。
${style ? `\n风格要求：\n${style}` : ''}${antiCliche ? `\n\n${antiCliche}` : ''}

剧情摘要：${summary || '（无）'}
说话人画像：${profiles || '（无）'}`
}

/**
 * 反翻译腔禁令族提示词（P1）：按启用分类生成「禁止清单 + 替代写法」。
 * 原则：仅当源文无对应内容时适用；源文确有对应则照常保留。enabledIds 空=全部分类。
 */
export function antiClichePrompt(enabledIds: string[] | undefined): string {
  const wanted = enabledIds && enabledIds.length > 0 ? enabledIds : undefined
  const cats = ANTI_CLICHE_CATEGORIES.filter((c) => !wanted || wanted.includes(c.id))
  if (cats.length === 0) return ''
  const lines = cats.map((c) => {
    const words = c.triggers.map((t) => t.word).join('、')
    return `- 【${c.label}】${c.rationale} 触发词：${words}。${c.suggestions}`
  })
  return [
    '反翻译腔要求（仅当源文无对应内容时适用；源文确有对应则照常保留，不机械删词）：',
    ...lines,
  ].join('\n')
}

/** 风格预设文案（方案 A 三档）。 */
export function stylePresetText(preset: string): string {
  switch (preset) {
    case 'faithful':
      return '忠实原文：以直译为主，尽量保留原句结构与字面信息，不自由发挥、不意译增色。'
    case 'standard':
      return '自然通顺：以中文自然表达为准，适度意译，语句通顺易读，信息完整。'
    case 'literary':
      return '文学化：贴合人物性格与氛围，可适度润色与文学化表达，但仍不得增删信息或脱离原文。'
    default:
      return ''
  }
}

/** 组装风格指令（预设 + 自定义 + 自定义翻译头，供 rewrite/polish 提示词注入）。 */
export function styleInstruction(preset: string, customPrompt: string, head = ''): string {
  const parts: string[] = []
  const base = stylePresetText(preset.trim())
  if (base) parts.push(base)
  const custom = (customPrompt ?? '').trim()
  if (custom) parts.push(`用户补充风格要求：${custom}`)
  const headText = (head ?? '').trim()
  if (headText) parts.push(`用户自定义翻译头：${headText}`)
  return parts.join('\n')
}

export function worldbookPrompt(maxChars: number): string {
  return `你是长文本世界设定整理器。下面是源文本片段（已去除装饰性标签）。

提取该片段中【明确出现】的世界设定条目，输出 JSON 数组，元素字段：
- "kind": "name"（人物/角色）| "term"（专有名词/术语）| "setting"（地点/世界观/组织/事件背景）| "lore"（其他长期设定）
- "title": 中文条目名，人物建议「中文名（English Name）」格式
- "keywords": 原文中出现的英文拼写数组（含缩写/昵称/变体，用于词边界激活）
- "content": 中文说明，只写片段中明确出现的信息（身份/关系/职能/背景），禁止编造，不超过 ${maxChars} 字
- "source_refs": 来源标记数组（如 [文件:行号]），1-3 个

规则：
- 排除一次性事件经过、价格、日常物品、UI 文案等噪声。
- 没有可靠条目时输出 []。只输出 JSON 数组。`
}

/** 术语驱动世界书提示词：按名单逐名字出卡或判 noinfo，返回带 source 的 JSON 数组。 */
export function worldbookTermsPrompt(maxChars: number): string {
  return `你是长文本世界设定整理器。下面是若干「名字」以及它们在全书不同位置的上下文片段（每行保留 [文件:行号] 前缀）。

对每个列出的名字：
- 有明确可写的背景时，输出一条世界书条目；
- 没有值得记录的背景（普通日常词、无需解释的常识词等）时，输出 {"source": "<名字>", "noinfo": true}。

只输出一个 JSON 数组，元素字段：
- "source": 名字原文（必须与给出的名字一致，用于对齐）
- "kind": "name"（人物/角色）| "term"（专有名词/术语）| "setting"（地点/世界观/组织/事件背景）| "lore"（其他长期设定）
- "title": 中文条目名，人物建议「中文名（English Name）」格式；涉及锁定译名时标题必须用锁定译名
- "keywords": 原文中出现的英文拼写数组（含缩写/昵称/变体，用于词边界激活）
- "content": 中文说明，不超过 ${maxChars} 字
- "source_refs": 来源标记数组（如 [文件:行号]），取自上面给出的上下文，至少 2 个不同窗口
- "noinfo": 仅当判定无背景可提取时为 true

全书级综合规则：
- 人物/角色（name）与地点/组织（setting）：把给出的多个上下文窗口当作全书线索，综合成一张完整画像——身份、与其他人物/地点/组织的关系、动机、在剧情中的作用，跨窗口相互印证，不要只复述单一窗口的句子。
- term/lore：只写上下文片段中明确出现的信息，禁止编造。
- 所有条目只依据给出的上下文，禁止编造；片段中没有的信息不要写。
- 每个列出的名字都必须出现一次（条目或 noinfo），不得遗漏。
- 只输出 JSON 数组。`
}

/**
 * 世界书三问判据（提名制核心）。只写判定规则，不写论证——模型要的是可执行的判据。
 */
export const WORLDBOOK_THREE_QUESTIONS = `判断一个实体是否值得进入世界书，只看三问：
1. 是设定级实体吗？人物/地点/组织/世界观规则/游戏机制才算；俚语、玩梗词、普通名词、拟声词一律不算；
2. 出现跨场景分散吗？只在个别场景集中出现的（哪怕被高频提及）不需要卡；
3. 缺了背景，翻译远处场景会实际出错吗（称呼/关系/语气）？不会的不需要卡。`

/** 理解沉淀提示词：从场景理解摘录中提取设定级实体提名（提取+三问判据一步完成）。 */
export function worldbookSedimentPrompt(): string {
  return `你是世界书提名器。下面是一本作品各场景的理解摘录（地点/在场角色/事件/长期伏笔）。

按三问判据提取值得进入世界书的「设定级实体」（人物/地点/组织/世界观规则/机制）：

${WORLDBOOK_THREE_QUESTIONS}

规则与关系类设定（无稳定名字的背景知识，如能力限制、人物隐藏关系）也提名，kind 用 "lore"，source 写一个稳定的中文短名。

只输出一个 JSON 数组，元素字段：
- "source": 实体稳定名（人物用原文拼写，规则/关系用中文短名）
- "kind": "name" | "setting" | "lore"
- "hint": 一句话说明该实体的核心设定（供出卡时的背景线索）
- "scenes": 支撑该提名的场景 id 数组（取自摘录前缀），1-5 个

宁缺毋滥。只输出 JSON 数组。`
}

/** 扫描候选提名推荐提示词：对词表候选批量给三问判定与理由（推荐而非闸门）。 */
export function worldbookNominatePrompt(): string {
  return `你是世界书提名评审。下面是候选名字及其证据（出现次数、跨场景分布、样例句）。

对每个候选按三问判据给出是否推荐出卡：

${WORLDBOOK_THREE_QUESTIONS}

只输出一个 JSON 数组，每个候选一项，按候选顺序：
- "source": 候选原文（必须与给出的一致，用于对齐）
- "recommended": true/false
- "reason": 一句话理由（指出三问中哪一条不通过，或为什么通过）
- "kind": "name" | "term" | "setting" | "lore"（推荐时的建议类别）

每个候选都必须出现一次。只输出 JSON 数组。`
}

export function deliberationEvalPrompt(): string {
  return `你是翻译术语决策助手。针对下面的候选术语，结合【查证证据】（可能为空）与【出现语境】，从多个方面评估并给出决策建议。

评估方面：
1. 语境：候选在各语境中的含义与用法是否一致；
2. 音义：译名是否兼顾读音与含义（专名音译、术语意译或约定俗成）；
3. 权威/社区：官方或社区已有的通行译名（依据查证证据）；
4. 文化/韵律：是否符合目标语言习惯、是否顺口、有无歧义或撞车。

输出合法 JSON 对象，字段：
- "target": 建议译名
- "confidence": "high" | "medium" | "low"
- "rationale": 决策理由（多方位简述）
- "alternatives": 备选译名数组
- "collision": 与已有锁定译名冲突的说明（无则 ""）

只输出 JSON。`
}

export function deliberationBatchPrompt(items: string): string {
  return `你是翻译术语决策助手。针对下面的一批候选术语，结合各自的【查证证据】（可能为空）与【出现语境】，逐条评估。

评估方面：
1. 语境：候选在各语境中的含义与用法是否一致；
2. 音义：译名是否兼顾读音与含义（专名音译、术语意译或约定俗成）；
3. 权威/社区：官方或社区已有的通行译名（依据查证证据）；
4. 文化/韵律：是否符合目标语言习惯、是否顺口、有无歧义或撞车。

只输出一个合法 JSON 数组（不要 markdown 围栏），元素按候选顺序对应，每项字段：
- "source": 候选原文（用于对齐）
- "target": 建议译名
- "confidence": "high" | "medium" | "low"
- "rationale": 决策理由（多方位简述）
- "collision": 与已有锁定译名冲突的说明（无则 ""）

候选列表：
${items}`
}
