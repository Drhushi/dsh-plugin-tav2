import Schema from '@deepseek-ai/schemastery'

/** 翻译专用 API 的默认密钥引用名（可被 apiKeyEnv 覆盖；留空=本地模型无鉴权）。 */
export const DEFAULT_TRANSLATION_API_KEY_ENV = 'TRANSLATE_API_KEY'

/** 翻译专用 API 覆盖范围（决定哪些调用点走专用 API）。 */
export const TRANSLATION_SCOPE_VALUES = ['main', 'all', 'experimental'] as const
export type TranslationScope = (typeof TRANSLATION_SCOPE_VALUES)[number]

/**
 * 可选翻译专用 API（OpenAI 兼容 HTTP）。所有字段留空/未配置时行为不变：
 * 翻译继续走宿主 ctx.llm。
 * - baseUrl：专用 API 根地址（非空且密钥满足时才启用，否则静默回退宿主）。
 * - model：专用 API 模型名；留空则用项目 config.yaml 的 llm.model。
 * - scope：覆盖范围（main=主链路+世界书等知识类，experimental=仅主链路；all 与 main 等价，兼容保留）。
 * - apiKeyEnv：取密钥的环境变量名（默认 TRANSLATE_API_KEY）；留空=本地模型无鉴权。
 * 密钥值永不落 settings/state.json 明文，只经宿主 credentials 域与环境变量。
 */
export interface TranslationApiConfig {
  baseUrl?: string
  model?: string
  scope?: TranslationScope
  apiKeyEnv?: string
}

/** 插件配置：如何调用 tav2 的 Python 核心，以及编排行为。 */
export interface Config {
  /** Python 可执行文件（默认 python，可填完整路径） */
  python: string
  /** tav2 模块名（python -m <module>） */
  module: string
  /** config.yaml 显式路径；留空则由 tav2 自动查找 */
  configPath: string
  /** 命令执行的工作目录（应包含 config.yaml，或配合 configPath 使用） */
  projectDir: string
  /** tav2 Python 仓库根目录（应含 tav2/ 包与 config.yaml）；留空则读 TAV2_PYTHON_REPO 环境变量，都没有时靠 projectDir 的 cwd 解析 */
  pythonRepo?: string
  /** 引擎读取的 config.yaml 显式路径；留空则用 projectDir/config.yaml */
  engineConfigPath: string
  /** 会话级项目覆盖（tav2_select_project 写入）；留空表示不覆盖 */
  projectOverride: string
  /** 会话级游戏目录覆盖（tav2_select_project 按 recent 条目切换时写入）；留空表示不覆盖 */
  gameDirOverride?: string
  /** 会话级目标语言覆盖（/tav2-lang 写入）；留空表示不覆盖，引擎默认 chinese */
  langOverride?: string
  /** 会话级引擎覆盖（工作区自动探测写入，如 renpy）；留空表示用配置 engine */
  engineOverride?: string
  /** dsh 里注册的 LLM provider 名（TS 引擎经 ctx.llm 调用时使用） */
  llmProvider: string
  /** 前台命令超时（毫秒）；后台任务不受此限制，由 job_kill 控制 */
  timeoutMs: number
  /** 返回给模型的最大输出字符数（超出截断） */
  maxOutputChars: number
  /**
   * 引擎后端：M6 起默认 ts（全量 TS 引擎）；
   * python 保留作回退与 A/B 复测（TAV2_PYTHON_REPO 基线对比）。
   */
  engineBackend: 'python' | 'ts'
  /**
   * 审批策略：ask=交互审批（默认）；never=自动拒绝写操作
   * （对应 tav2 自主级别 auto_high 的无打扰模式）。
   */
  approval: 'ask' | 'never'
  /** 分批翻译时并行子代理数量上限（默认 2）。<=1 时不派生子代理，单批直跑。 */
  subagentMaxWorkers?: number
  /**
   * 后台任务策略：
   * auto=先启动后台任务，失败（无 job controller 服务本 agent）时经用户知情确认后前台降级（默认）；
   * background=只走后台，失败原样抛错；foreground=跳过后台直接前台执行。
   */
  jobBackend?: 'auto' | 'background' | 'foreground'
  /** 可选翻译专用 API（yaml 配置层；settings/state.json 里的界面值会覆盖它）。 */
  translationApi?: TranslationApiConfig
  /**
   * Ren'Py SDK 的绝对路径（如 D:/renpy-8.5.3-sdk）。
   * 作用：.rpyc 已编译游戏的 prepare 需要官方 SDK/unrpyc 才能生成翻译模板——
   * 填了它，遇 .rpyc 游戏会自动走官方 renpy translate 路线，无需每次手动传 --sdk。
   * .rpy 源码游戏仍默认走 TS 原生（更快、不依赖 python）。
   * 留空则 .rpyc 游戏需每次在 tav2_prepare 传 --sdk。
   */
  renpySdk?: string
  /**
   * 翻译模板生成（prepare）用的后端：
   * - auto（默认）：.rpy 源码游戏走 TS 原生（不依赖 python），.rpyc 游戏或传 --sdk 走 Python；
   * - ts：强制只走 TS 原生（遇 .rpyc 报错，完全不碰 python）；
   * - python：强制走 Python（用官方 SDK 生成更完整的模板，或排查 TS 产出问题时）。
   */
  prepareBackend?: 'auto' | 'ts' | 'python'
}

export const Config = Schema.object({
  python: Schema.string().default('python'),
  module: Schema.string().default('tav2'),
  configPath: Schema.string().default(''),
  projectDir: Schema.string().default(''),
  pythonRepo: Schema.string().default(''),
  engineConfigPath: Schema.string().default(''),
  projectOverride: Schema.string().default(''),
  gameDirOverride: Schema.string().default(''),
  langOverride: Schema.string().default(''),
  engineOverride: Schema.string().default(''),
  llmProvider: Schema.string().default('deepseek-official'),
  timeoutMs: Schema.number().default(900_000),
  maxOutputChars: Schema.number().default(20_000),
  engineBackend: Schema.union(['python', 'ts']).default('ts'),
  approval: Schema.union(['ask', 'never']).default('ask'),
  subagentMaxWorkers: Schema.number().min(1).default(2),
  jobBackend: Schema.union(['auto', 'background', 'foreground'] as const).default('auto'),
  translationApi: Schema.object({
    baseUrl: Schema.string().default(''),
    model: Schema.string().default(''),
    scope: Schema.union(['main', 'all', 'experimental']).default('main'),
    apiKeyEnv: Schema.string().default(DEFAULT_TRANSLATION_API_KEY_ENV),
  }).default({ baseUrl: '', model: '', scope: 'main', apiKeyEnv: DEFAULT_TRANSLATION_API_KEY_ENV }),
  renpySdk: Schema.string()
    .description(
      "Ren'Py SDK 的绝对路径（如 D:/renpy-8.5.3-sdk）。作用：.rpyc 已编译游戏的翻译模板生成需要官方 SDK/unrpyc——填了它，遇 .rpyc 游戏会自动走官方 renpy translate 路线，无需每次手动传 --sdk。.rpy 源码游戏仍默认走 TS 原生（更快、不依赖 python）。留空则 .rpyc 游戏需每次在 tav2_prepare 传 --sdk。",
    )
    .default(''),
  prepareBackend: Schema.union(['auto', 'ts', 'python'] as const)
    .description(
      '翻译模板生成（prepare）用的后端：auto（默认）= .rpy 源码游戏走 TS 原生、.rpyc 游戏或传 --sdk 走 Python；ts = 强制只走 TS 原生（完全不碰 python，遇 .rpyc 会报错）；python = 强制走 Python（用官方 SDK 生成更完整的模板，或排查 TS 产出问题时用）。',
    )
    .default('auto'),
})
