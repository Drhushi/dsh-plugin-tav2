/**
 * Ren'Py 侧数据模型（移植自 tav2 的 adapters/renpy/renpy_models.py）。
 * 兼容 resolveJsonModule 与 strict 模式。
 */
import { encodeSayString } from './compat'

/** 对话块中的一条 say 语句。prefix/suffix 保留语句结构，翻译只替换 what。 */
export class SayLine {
  who: string | null
  what: string
  prefix: string
  suffix: string
  raw: string
  explicitId: string | null = null
  originalWhat: string | null = null
  indent: string

  constructor(options: {
    who: string | null
    what: string
    prefix: string
    suffix: string
    raw: string
    explicitId?: string | null
    originalWhat?: string | null
    indent?: string
  }) {
    this.who = options.who
    this.what = options.what
    this.prefix = options.prefix
    this.suffix = options.suffix
    this.raw = options.raw
    this.explicitId = options.explicitId ?? null
    this.originalWhat = options.originalWhat ?? null
    this.indent = options.indent ?? ''
  }

  /** 复刻 renpy_models.SayLine.render：只替换 what，保留 prefix/suffix/indent。 */
  render(what: string | null = null): string {
    const text = encodeSayString(what === null ? this.what : what)
    const parts = this.prefix ? [this.prefix, text] : [text]
    if (this.suffix) parts.push(this.suffix)
    return this.indent + parts.join(' ')
  }
}

/** 一个对话翻译单元（对应 tl 文件中的一个 translate 块）。 */
export class DialogueUnit {
  identifier: string
  filename: string
  linenumber: number
  label: string | null
  sayLines: SayLine[]
  rawStatements: string[]
  sayMachine: Map<number, string>

  constructor(options: {
    identifier: string
    filename: string
    linenumber: number
    label?: string | null
    sayLines?: SayLine[]
    rawStatements?: string[]
    sayMachine?: Map<number, string>
  }) {
    this.identifier = options.identifier
    this.filename = options.filename
    this.linenumber = options.linenumber
    this.label = options.label ?? null
    this.sayLines = options.sayLines ?? []
    this.rawStatements = options.rawStatements ?? []
    this.sayMachine = options.sayMachine ?? new Map()
  }

  get sourceText(): string {
    return this.sayLines.map((s) => s.what).filter(Boolean).join('\n')
  }

  get translatedText(): string {
    const lines = this.sayLines.filter((s) => s.what)
    if (lines.length === 0) return ''
    const translated = this.sayLines
      .map((s, i) => (s.what ? this.sayMachine.get(i) ?? s.what : ''))
      .filter((t) => t !== '')
    return translated.join('\n')
  }
}

/** 一个字符串翻译条目（translate strings 块中的 old/new 对）。 */
export class StringUnit {
  old: string
  new: string
  filename: string
  linenumber: number
  machine = ''
  human = ''
  status = '待审'

  constructor(options: {
    old: string
    new: string
    filename: string
    linenumber: number
  }) {
    this.old = options.old
    this.new = options.new
    this.filename = options.filename
    this.linenumber = options.linenumber
  }

  get sourceText(): string {
    return this.old
  }

  get translatedText(): string {
    return this.human || this.machine
  }

  get isTranslated(): boolean {
    return Boolean(this.new) && this.new !== this.old
  }
}

/** strings 块中的一对 old/new。 */
export interface StringPair {
  oldIdx: number
  newIdx: number
  old: string
  new: string
}

/** 一个 tl 块：dialogue | strings | python | style | raw。 */
export interface TlChunk {
  kind: string
  raw: string[]
  headerIndex: number
  identifier: string | null
  sayLines: SayLine[]
  originals: (SayLine | null)[]
  /** 元素为 [行号(文件内), 原始行文本, 是否为 say 行] */
  bodyLines: Array<[number, string, boolean]>
  pairs: StringPair[]
}
