/**
 * 引擎无关数据模型：Document → Scene → Unit，以及场景理解记录。
 * 字段与 tav2 Python 的 tav2/models.py 一一对应（JSON 形状兼容）。
 */

export const UNIT_KINDS = ['dialogue', 'narration', 'choice', 'string'] as const

/** 原子可译项。 */
export class Unit {
  /** 引擎稳定 id（Ren'Py=官方 md5 标识符；小说=章:段 hash） */
  unit_id: string
  /** dialogue | narration | choice | string */
  kind: string
  /** 原文 */
  source: string
  /** Ren'Py 标签/插值或 markdown 格式符（保留字符串） */
  markup: string
  /** 规范化角色 id（空=旁白/无） */
  speaker: string
  scene_id: string
  prev_ids: string[]
  /** 适配器私有元数据 */
  extra: Record<string, unknown>

  constructor(
    unit_id: string,
    kind: string,
    source: string,
    markup = '',
    speaker = '',
    scene_id = '',
    prev_ids: string[] = [],
    extra: Record<string, unknown> = {},
  ) {
    this.unit_id = unit_id
    this.kind = kind
    this.source = source
    this.markup = markup
    this.speaker = speaker
    this.scene_id = scene_id
    this.prev_ids = prev_ids
    this.extra = extra
  }

  get key(): string {
    return this.unit_id
  }
}

/** 语义块（Ren'Py label + 连续行；小说=章/节），按阅读顺序排列。 */
export class Scene {
  scene_id: string
  title: string
  order: number
  units: Unit[]
  /** 分支轨道 id（主线=main） */
  branch: string
  extra: Record<string, unknown>

  constructor(
    scene_id: string,
    title: string,
    order: number,
    units: Unit[] = [],
    branch = 'main',
    extra: Record<string, unknown> = {},
  ) {
    this.scene_id = scene_id
    this.title = title
    this.order = order
    this.units = units
    this.branch = branch
    this.extra = extra
  }
}

/** 一份归一化后的源文档。 */
export class Document {
  engine: string
  game_dir: string
  lang: string
  scenes: Scene[]
  extra: Record<string, unknown>

  constructor(
    engine: string,
    game_dir: string,
    lang: string,
    scenes: Scene[] = [],
    extra: Record<string, unknown> = {},
  ) {
    this.engine = engine
    this.game_dir = game_dir
    this.lang = lang
    this.scenes = scenes
    this.extra = extra
  }

  allUnits(): Unit[] {
    return this.scenes.flatMap((scene) => scene.units)
  }

  /** 从 Python 桥导出的 Document JSON 构造。 */
  static fromJson(data: DocumentJson): Document {
    return new Document(
      data.engine,
      data.game_dir,
      data.lang,
      (data.scenes ?? []).map(
        (s) => new Scene(
          s.scene_id,
          s.title,
          s.order,
          (s.units ?? []).map(
            (u) => new Unit(
              u.unit_id,
              u.kind,
              u.source,
              u.markup ?? '',
              u.speaker ?? '',
              u.scene_id ?? '',
              u.prev_ids ?? [],
              u.extra ?? {},
            ),
          ),
          s.branch ?? 'main',
          s.extra ?? {},
        ),
      ),
      data.extra ?? {},
    )
  }
}

export interface UnitJson {
  unit_id: string
  kind: string
  source: string
  markup?: string
  speaker?: string
  scene_id?: string
  prev_ids?: string[]
  extra?: Record<string, unknown>
}

export interface SceneJson {
  scene_id: string
  title: string
  order: number
  branch?: string
  extra?: Record<string, unknown>
  units: UnitJson[]
}

export interface DocumentJson {
  engine: string
  game_dir: string
  lang: string
  scenes: SceneJson[]
  extra?: Record<string, unknown>
}

export class ThreadItem {
  id: string
  kind: string // short | long
  text: string
  scenes_since: number

  constructor(id: string, kind: string, text: string, scenes_since = 0) {
    this.id = id
    this.kind = kind
    this.text = text
    this.scenes_since = scenes_since
  }
}

export interface ThreadDict {
  id: string
  kind: string
  text: string
  scenes_since: number
}

/** UnderstandingRecord 的持久化 JSON 形状（与 Python to_dict 一致）。 */
export interface UnderstandingDict {
  scene_id: string
  scene_state: Record<string, unknown>
  threads: ThreadDict[]
  term_usage: Array<Record<string, string>>
  style_notes: Array<Record<string, string>>
  /** 场景级文风/口吻指引（软字段，缺省空串） */
  tone: string
  flags: Array<Record<string, string>>
  raw: Record<string, unknown>
}

/** 每场景结构化理解记录（双阶段协议的第一步产物）。 */
export class UnderstandingRecord {
  scene_id: string
  /** 时间/地点/在场角色/事件 */
  scene_state: Record<string, unknown>
  threads: ThreadItem[]
  /** {source, target} */
  term_usage: Array<Record<string, string>>
  /** {speaker, note} */
  style_notes: Array<Record<string, string>>
  /** 场景级文风/口吻/氛围指引（软字段，缺省空串） */
  tone: string
  /** {kind, source, hint} */
  flags: Array<Record<string, string>>
  raw: Record<string, unknown>

  constructor(
    scene_id: string,
    scene_state: Record<string, unknown> = {},
    threads: ThreadItem[] = [],
    term_usage: Array<Record<string, string>> = [],
    style_notes: Array<Record<string, string>> = [],
    flags: Array<Record<string, string>> = [],
    raw: Record<string, unknown> = {},
    tone = '',
  ) {
    this.scene_id = scene_id
    this.scene_state = scene_state
    this.threads = threads
    this.term_usage = term_usage
    this.style_notes = style_notes
    this.tone = tone
    this.flags = flags
    this.raw = raw
  }

  /** 方案 F 理解硬闸门：字段完整率校验。scene_state 至少一个字段；threads 每条必须有 id+text。 */
  completeness(): { ok: boolean; missing: string[] } {
    const missing: string[] = []
    if (!this.scene_id) missing.push('scene_id')
    if (Object.keys(this.scene_state).length === 0) missing.push('scene_state')
    for (const t of this.threads) {
      if (!t.id || !t.text) missing.push(`thread:${t.id || '?'}`)
    }
    return { ok: missing.length === 0, missing }
  }

  toDict(): UnderstandingDict {
    return {
      scene_id: this.scene_id,
      scene_state: this.scene_state,
      threads: this.threads.map((t) => ({
        id: t.id,
        kind: t.kind,
        text: t.text,
        scenes_since: t.scenes_since,
      })),
      term_usage: this.term_usage,
      style_notes: this.style_notes,
      tone: this.tone,
      flags: this.flags,
      raw: this.raw,
    }
  }

  static fromDict(data: Partial<UnderstandingDict>): UnderstandingRecord {
    const threads = (data.threads ?? []).map(
      (t) => new ThreadItem(
        String(t.id ?? ''),
        String(t.kind ?? 'short'),
        String(t.text ?? ''),
        Number(t.scenes_since ?? 0),
      ),
    )
    return new UnderstandingRecord(
      String(data.scene_id ?? ''),
      (data.scene_state ?? {}) as Record<string, unknown>,
      threads,
      (data.term_usage ?? []) as Array<Record<string, string>>,
      (data.style_notes ?? []) as Array<Record<string, string>>,
      (data.flags ?? []) as Array<Record<string, string>>,
      (data.raw ?? {}) as Record<string, unknown>,
      String(data.tone ?? ''),
    )
  }
}
