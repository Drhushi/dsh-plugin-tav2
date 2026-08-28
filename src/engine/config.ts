import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import yaml from 'js-yaml'

/** 引擎侧配置（与 tav2 config.example.yaml 同名段映射，字段转 camelCase）。 */
export interface EngineConfig {
  engine: string
  gameDir: string
  /** 持久化的游戏目录覆盖（config.yaml 顶层 game_dir_override，编译版 _prep 暂存项目）。 */
  gameDirOverride?: string
  lang: string
  llm: {
    baseUrl: string
    apiKeyEnv: string
    apiKey: string
    model: string
    temperature: number
    maxTokens: number
    timeout: number
    reasoningEffort: string
    pricePer1mInput: number
    pricePer1mOutput: number
    mock: boolean
  }
  context: {
    maxTokens: number
    sceneMaxUnits: number
    adaptiveBatch: boolean
    budgetTokens: number
    adaptiveMinUnits: number
    adaptiveMinTokens: number
    adaptiveMaxUnits: number
    adaptiveMaxTokens: number
    adaptiveShrink: number
    adaptiveGrow: number
    adaptiveFailThreshold: number
    adaptiveSuccessThreshold: number
    summaryTokens: number
    fewShotPairs: number
    summaryEvery: number
    polishEvery: number
    maxWorkers: number
    understandingReasoningEffort: string
  }
  worldbook: {
    enabled: boolean
    chunkTokens: number
    maxConstants: number
    maxContentChars: number
    reasoningEffort: string
    /** 每个名字最多取的上下文窗口数（首现 + 均匀中间 + 末现）。 */
    sampleWindows: number
    /** 每个窗口向首尾各扩几行。 */
    windowRadius: number
    /** 每批最多放几个名字进一次 LLM 调用。 */
    batchTerms: number
    /** 提名硬淘汰阈值：时序跨度（出现范围/全书行数）低于它的候选连提名都不进。 */
    minSpread: number
    /** 理解沉淀通道开关：从场景理解记录提取设定级实体提名。 */
    sediment: boolean
    /** 理解沉淀每次 LLM 调用最多带的场景摘录数。 */
    sedimentBatchScenes: number
  }
  scan: {
    enabled: boolean
    minFrequency: number
    stopwords: string[]
    maxItems: number
    contextWindowLines: number
    maxContextSamples: number
    sourceLanguageGuard: boolean
    /** 专名白名单：游戏特有小写设定词（mood/blush 等），扫描按专名兜底进候选。 */
    extraProperNouns: string[]
  }
  deliberation: {
    batchSize: number
    autoApproveHigh: boolean
  }
  search: {
    enabled: boolean
    engine: string
    apiKeyEnv: string
    maxResults: number
    timeout: number
  }
  memory: {
    vectorEnabled: boolean
    embeddingModel: string
    topK: number
  }
  branch: {
    parallel: boolean
    detect: boolean
  }
  review: {
    enabled: boolean
  }
  fonts: {
    enabled: boolean
    default: string
    map: Record<string, string>
    names: Record<string, string>
    dir: string
  }
  reviewDir: string
  runtime: {
    /** 运行时日志路径（缺省由适配器给出）。 */
    logPaths: string[]
    /** 本游戏需要的运行时伴侣组件（存在性自检，不进补丁包 manifest）。 */
    requirements: { id: string; name: string; paths: string[]; doc?: string }[]
  }
  localization: {
    style: string
  }
  debug: {
    /** 非空时把每次 LLM 调用的完整请求（system+messages 全文+采样参数）+响应落盘为 JSONL（请求快照，供 A/B 审计/回放）。 */
    requestSnapshotDir: string
  }
  translation: {
    /** 翻译风格预设：faithful（忠实直译）| standard（自然通顺）| literary（文学化）。空=未设定（启动时询问）。 */
    stylePreset: string
    /** 自定义风格说明；非空时叠加到预设之上。 */
    stylePrompt: string
    /** 自定义「翻译头」：用户整段覆写/补充喂给模型的翻译指令（注入 rewrite/polish 系统提示）。 */
    head: string
    /** 反翻译腔禁令族升级（P1）：enabled 缺省 true（P1 结构，A/B 盲评采纳）；categories 空=全部分类启用。 */
    antiCliche: {
      enabled: boolean
      /** true=确定性移除填充词；false=仅报告命中（不改译文）。 */
      autoFix: boolean
      /** 启用哪些分类（id 列表）；空=全部分类启用。 */
      categories: string[]
    }
  }
  recentProjects: RecentProjectInfo[]
}

/** recent_projects 中的一条项目记录：兼容 v1 {path,name} 与 v2 {name,game_dir}。 */
export interface RecentProjectInfo {
  name: string
  path: string
}

function recentProjectsFromRaw(value: unknown): RecentProjectInfo[] {
  if (!Array.isArray(value)) return []
  const out: RecentProjectInfo[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      const path = item.trim()
      const name = basename(path) || path
      out.push({ name, path })
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const path = str(rec.path, '') || str(rec.game_dir, '') || ''
      const name = str(rec.name, '') || basename(path) || ''
      if (path) out.push({ name, path })
    }
  }
  return out
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function strList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function strMap(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object') return fallback
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

/** 从 config.yaml 的原始对象构造带默认值的引擎配置。 */
export function engineConfigFromRaw(raw: DeepPartial<Record<string, unknown>> | null | undefined): EngineConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const llm = (r.llm ?? {}) as Record<string, unknown>
  const context = (r.context ?? {}) as Record<string, unknown>
  const worldbook = (r.worldbook ?? {}) as Record<string, unknown>
  const scan = (r.scan ?? {}) as Record<string, unknown>
  const deliberation = (r.deliberation ?? {}) as Record<string, unknown>
  const search = (r.search ?? {}) as Record<string, unknown>
  const memory = (r.memory ?? {}) as Record<string, unknown>
  const branch = (r.branch ?? {}) as Record<string, unknown>
  const review = (r.review ?? {}) as Record<string, unknown>
  const fonts = (r.fonts ?? {}) as Record<string, unknown>
  const localization = (r.localization ?? {}) as Record<string, unknown>
  const translation = (r.translation ?? {}) as Record<string, unknown>
  const runtime = (r.runtime ?? {}) as Record<string, unknown>
  const debug = (r.debug ?? {}) as Record<string, unknown>
  const antiCliche = (translation.anti_cliche ?? {}) as Record<string, unknown>

  const cfg: EngineConfig = {
    engine: str(r.engine, 'renpy'),
    gameDir: str(r.game_dir, ''),
    // 持久化的游戏目录覆盖（编译版 _prep 暂存项目）：select_project 写入 config.yaml，
    // 让面板/工具链在进程重启后仍指向会话绑定的游戏目录（内存态覆盖会随进程丢失）。
    gameDirOverride: str(r.game_dir_override, '') || undefined,
    lang: str(r.lang, 'chinese'),
    llm: {
      baseUrl: str(llm.base_url, 'https://api.deepseek.com/v1'),
      apiKeyEnv: str(llm.api_key_env, 'TRANSLATE_AGENT_API_KEY'),
      apiKey: str(llm.api_key, ''),
      model: str(llm.model, 'deepseek-v4-flash'),
      temperature: num(llm.temperature, 0.3),
      maxTokens: num(llm.max_tokens, 8192),
      timeout: num(llm.timeout, 180),
      reasoningEffort: str(llm.reasoning_effort, ''),
      pricePer1mInput: num(llm.price_per_1m_input, 0),
      pricePer1mOutput: num(llm.price_per_1m_output, 0),
      mock: bool(llm.mock, false),
    },
    context: {
      maxTokens: num(context.max_tokens, 6000),
      sceneMaxUnits: num(context.scene_max_units, 40),
      adaptiveBatch: bool(context.adaptive_batch, true),
      budgetTokens: num(context.budget_tokens, 400000),
      adaptiveMinUnits: num(context.adaptive_min_units, 10),
      adaptiveMinTokens: num(context.adaptive_min_tokens, 1500),
      adaptiveMaxUnits: num(context.adaptive_max_units, 80),
      adaptiveMaxTokens: num(context.adaptive_max_tokens, 12000),
      adaptiveShrink: num(context.adaptive_shrink, 0.5),
      adaptiveGrow: num(context.adaptive_grow, 1.5),
      adaptiveFailThreshold: num(context.adaptive_fail_threshold, 2),
      adaptiveSuccessThreshold: num(context.adaptive_success_threshold, 3),
      summaryTokens: num(context.summary_tokens, 500),
      fewShotPairs: num(context.few_shot_pairs, 6),
      summaryEvery: num(context.summary_every, 5),
      polishEvery: num(context.polish_every, 5),
      maxWorkers: num(context.max_workers, 4),
      understandingReasoningEffort: str(context.understanding_reasoning_effort, ''),
    },
    worldbook: {
      enabled: bool(worldbook.enabled, true),
      chunkTokens: num(worldbook.chunk_tokens, 3200),
      maxConstants: num(worldbook.max_constants, 5),
      maxContentChars: num(worldbook.max_content_chars, 320),
      reasoningEffort: str(worldbook.reasoning_effort, 'none'),
      sampleWindows: num(worldbook.sample_windows, 6),
      windowRadius: num(worldbook.window_radius, 3),
      batchTerms: num(worldbook.batch_terms, 10),
      minSpread: num(worldbook.min_spread, 0.15),
      sediment: bool(worldbook.sediment, true),
      sedimentBatchScenes: num(worldbook.sediment_batch_scenes, 40),
    },
    scan: {
      enabled: bool(scan.enabled, true),
      minFrequency: num(scan.min_frequency, 6),
      stopwords: strList(scan.stopwords, []),
      maxItems: num(scan.max_items, 500),
      contextWindowLines: num(scan.context_window_lines, 2),
      maxContextSamples: num(scan.max_context_samples, 3),
      sourceLanguageGuard: bool(scan.source_language_guard, true),
      extraProperNouns: strList(scan.extra_proper_nouns, []),
    },
    deliberation: {
      batchSize: num(deliberation.batch_size, 10),
      autoApproveHigh: bool(deliberation.auto_approve_high, true),
    },
    search: {
      enabled: bool(search.enabled, false),
      engine: str(search.engine, 'off'),
      apiKeyEnv: str(search.api_key_env, 'TAVILY_API_KEY'),
      maxResults: num(search.max_results, 5),
      timeout: num(search.timeout, 15),
    },
    memory: {
      vectorEnabled: bool(memory.vector_enabled, false),
      embeddingModel: str(memory.embedding_model, ''),
      topK: num(memory.top_k, 3),
    },
    branch: {
      parallel: bool(branch.parallel, false),
      detect: bool(branch.detect, true),
    },
    review: {
      enabled: bool(review.enabled, false),
    },
    fonts: {
      enabled: bool(fonts.enabled, true),
      default: str(fonts.default, 'noto_sans_sc'),
      map: strMap(fonts.map, {}),
      names: strMap(fonts.names, {}),
      dir: str(fonts.dir, ''),
    },
    reviewDir: str(r.review_dir, 'projects'),
    runtime: {
      logPaths: strList(runtime.log_paths, []),
      requirements: ((runtime.requirements ?? []) as unknown[]).map((q) => {
        const x = (q ?? {}) as Record<string, unknown>
        return {
          id: str(x.id, ''),
          name: str(x.name, ''),
          paths: strList(x.paths, []),
          doc: str(x.doc, ''),
        }
      }).filter((q) => q.id && q.name && q.paths.length > 0),
    },
    localization: {
      style: str(localization.style, 'mixed'),
    },
    debug: {
      requestSnapshotDir: str(debug.request_snapshot_dir, ''),
    },
    translation: {
      stylePreset: str(translation.style_preset, ''),
      stylePrompt: str(translation.style_prompt, ''),
      head: str(translation.head, ''),
      antiCliche: {
        enabled: bool(antiCliche.enabled, true),
        autoFix: bool(antiCliche.auto_fix, false),
        categories: strList(antiCliche.categories, []),
      },
    },
    recentProjects: recentProjectsFromRaw(r.recent_projects),
  }
  if (cfg.gameDirOverride) cfg.gameDir = cfg.gameDirOverride
  return cfg
}

/** 解析 config.yaml 文本为引擎配置。 */
export function parseEngineConfig(yamlText: string): EngineConfig {
  let raw: unknown
  try {
    raw = yaml.load(yamlText) as unknown
  } catch {
    raw = null
  }
  return engineConfigFromRaw((raw ?? {}) as Record<string, unknown>)
}

/** 确定 config.yaml 路径：显式 configPath 优先，否则 projectDir/config.yaml。 */
export function resolveConfigPath(configPath: string | undefined, projectDir: string): string {
  if (configPath) return configPath
  return join(projectDir, 'config.yaml')
}

/** 读取并解析配置文件。 */
export function loadEngineConfig(configPath: string | undefined, projectDir: string): EngineConfig {
  const path = resolveConfigPath(configPath, projectDir)
  const text = readFileSync(path, 'utf8')
  return parseEngineConfig(text)
}

/** 工具层读取引擎配置：应用会话级 gameDirOverride（tav2_select_project 写入）。 */
export function loadEngineConfigFor(
  source: {
    engineConfigPath: string
    projectDir: string
    gameDirOverride?: string
    langOverride?: string
    engineOverride?: string
  },
): EngineConfig {
  const engineCfg = loadEngineConfig(source.engineConfigPath, source.projectDir)
  if (source.gameDirOverride) engineCfg.gameDir = source.gameDirOverride
  if (source.langOverride) engineCfg.lang = source.langOverride
  if (source.engineOverride) engineCfg.engine = source.engineOverride
  assertSupportedEngine(engineCfg)
  return engineCfg
}

/**
 * 引擎门禁：本插件自移除多引擎支持后仅接受 Ren'Py。
 * 旧项目（engine=unity-yarn / novel 等）在此 fail-closed，绝不静默降级或误当 renpy 处理。
 */
export function assertSupportedEngine(engineCfg: EngineConfig): void {
  if (engineCfg.engine === 'renpy') return
  throw new Error(
    `config.yaml 声明 engine=${engineCfg.engine}，但 dsh-plugin-tav2 当前适配器仅实现 Ren'Py（engine: renpy），`
    + '暂无法处理其他引擎。请改用 Ren\'Py 游戏，或在对应引擎适配器落地后再用。',
  )
}

/**
 * 复刻 Python resolve_project_dir(cfg, game_dir)：
 * review_dir 相对路径时基于 config.yaml 所在目录解析；返回 projects/<游戏名>。
 */
export function resolveProjectDir(
  engineConfig: EngineConfig,
  configPath: string | undefined,
  projectDir: string,
): string {
  const projectRoot = dirname(resolveConfigPath(configPath, projectDir))
  const base = isAbsolute(engineConfig.reviewDir)
    ? engineConfig.reviewDir
    : join(projectRoot, engineConfig.reviewDir || 'projects')
  return join(base, basename(engineConfig.gameDir) || 'game')
}

/** 返回 TS 引擎的项目 DB 路径（projects/<游戏名>/db.sqlite）。 */
export function resolveProjectDbPath(
  engineConfig: EngineConfig,
  configPath: string | undefined,
  projectDir: string,
): string {
  return join(resolveProjectDir(engineConfig, configPath, projectDir), 'db.sqlite')
}

/** 从配置文件取 recent_projects（供 tav2_select_project 使用）。 */
export function readRecentProjects(configPath: string | undefined, projectDir: string): RecentProjectInfo[] {
  try {
    const config = loadEngineConfig(configPath, projectDir)
    return config.recentProjects
  } catch {
    return []
  }
}

/**
 * 旧暂存链路项目数据迁移：prepare 重构后编译版游戏直接绑定真实游戏目录，
 * 项目 DB 从 projects/<游戏名>_prep 变为 projects/<游戏名>。检测到旧目录有
 * db.sqlite 且新目录还没有时整体拷贝（含审校 CSV / 审批 / 指纹），术语、
 * 世界书与翻译记忆不丢；旧目录保留不删。返回给用户看的说明（未迁移返回 null）。
 */
export function migrateLegacyPrepProject(source: {
  engineConfigPath: string
  projectDir: string
  gameDirOverride?: string
  langOverride?: string
  engineOverride?: string
}): string | null {
  let engineCfg: EngineConfig
  try {
    engineCfg = loadEngineConfigFor(source)
  } catch {
    return null
  }
  if (engineCfg.engine !== 'renpy' || !engineCfg.gameDir) return null
  const gameName = basename(engineCfg.gameDir)
  if (!gameName || gameName.endsWith('_prep')) return null // 仍绑定旧暂存区：无需迁移
  const projectDir = resolveProjectDir(engineCfg, source.engineConfigPath, source.projectDir)
  const legacyDir = join(dirname(projectDir), `${gameName}_prep`)
  if (legacyDir === projectDir) return null
  if (!existsSync(join(legacyDir, 'db.sqlite'))) return null
  if (existsSync(join(projectDir, 'db.sqlite'))) return null
  try {
    mkdirSync(projectDir, { recursive: true })
    cpSync(legacyDir, projectDir, { recursive: true })
    return `已迁移旧暂存项目数据：${legacyDir} → ${projectDir}（术语/世界书/审校记录保留，旧目录未删除）。`
      + '若 config.yaml 仍残留 game_dir_override 指向旧暂存目录，请用 tav2_select_project 切回配置目录清除。'
  } catch (err) {
    console.warn('[dsh-plugin-tav2] 旧暂存项目数据迁移失败：', err)
    return null
  }
}
