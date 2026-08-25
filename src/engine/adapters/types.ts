/**
 * 引擎适配器统一接口（Phase 0 定稿）。
 *
 * 所有引擎适配器都实现同一套确定性操作：
 * detect / extract / inject / diff / coverage。
 * 程序管格式，模型管语言；本接口是 Agent 与引擎文件系统之间的唯一边界。
 * 自移除多引擎支持后仅 Ren'Py 实现本接口（unity-yarn / novel 已随 v0.x 移除）。
 */
import type { Document } from '../models'

/** 当前支持的引擎类型（仅 Ren'Py；unknown 表示未识别或已识别但不支持）。 */
export type EngineKind = 'renpy' | 'unknown'

/** detect() 的结果。 */
export interface DetectResult {
  engine: EngineKind
  detected: boolean
  gameRoot: string
  /** 0..1 的探测置信度，供 Agent 决定是否继续。 */
  confidence: number
  /** 只读探测到的文件布局/关键路径。 */
  layout: Record<string, unknown>
  message: string
}

export interface ExtractOptions {
  /** 目标语言目录，例如 chinese；缺省由适配器决定。 */
  lang?: string
  /** 可选：只提取这些相对路径（glob 后续可扩展）。 */
  filter?: string[]
  /** Ren'Py：是否按 label 前缀推导分支（与 Python branch.detect 对齐，缺省 true）。 */
  branchDetect?: boolean
}

export interface ExtractResult {
  document: Document
  /** 实际读取/解析的相对路径清单。 */
  files: string[]
  warnings: string[]
  counts: {
    scenes: number
    units: number
  }
}

export interface InjectOptions {
  lang: string
  /** 引擎无关的译文变更；Ren'Py 使用 {file|id -> 行号 -> 译文} 与 {file|old -> 译文}。 */
  dialogueMap?: unknown
  stringMap?: unknown
  dryRun?: boolean
}

export interface InjectResult {
  ok: boolean
  dryRun: boolean
  applied: number
  skipped: number
  unchanged: number
  files: string[]
  warnings: string[]
}

export interface DiffOptions {
  fromRoot: string
  toRoot: string
  lang?: string
}

export interface DiffResult {
  added: string[]
  modified: string[]
  removed: string[]
  unchanged: string[]
}

export interface CoverageOptions {
  lang?: string
  expectedBlocks?: Set<string>
  expectedStrings?: Set<string>
}

export interface CoverageReport {
  total: number
  covered: number
  missing: number
  missingIds: string[]
  coverageRatio: number
  details: Record<string, unknown>
}

/** 运行时部署形态（译文如何被游戏引擎消费）：仅 Ren'Py tl/<lang>。 */
export type RuntimeModeKind = 'renpy-tl' | 'unknown'

export interface RuntimeMode {
  kind: RuntimeModeKind
  /** 运行时实际读取的译文目录（与 inject 目标同源；缺省 null 表示不适用）。 */
  translationDir: string | null
  note: string
}

export interface RuntimeCheck {
  id: string
  title: string
  /** info=提示/已知良性；warn=可能不生效；error=确定不生效。 */
  level: 'info' | 'warn' | 'error'
  ok: boolean
  detail: string
}

export interface RuntimeRequirement {
  id: string
  name: string
  /** 相对 gameRoot 的存在性探测路径；全部存在视为已安装。 */
  paths: string[]
  installed: boolean
  doc: string
}

export interface RuntimeCheckOptions {
  logPaths?: string[]
  /** 合并后的运行时伴侣组件清单（适配器默认 + 项目配置），供 checks 判定安装状态。 */
  requirements?: RuntimeRequirement[]
}

export interface EngineRuntime {
  /** 探测当前游戏的运行时部署形态；translationDir 与 inject 目标同源。 */
  modeOf(gameRoot: string, lang?: string): RuntimeMode
  /** 引擎默认的运行时伴侣组件（游戏无关；项目配置可追加）。 */
  defaultRequirements(gameRoot: string): RuntimeRequirement[]
  /** 失效点探测（canary 日志证据 / hook 告警等）。 */
  checks(gameRoot: string, options?: RuntimeCheckOptions): RuntimeCheck[]
  /** 可编程读取的运行时日志路径。 */
  logPaths(gameRoot: string): string[]
}

export interface EngineAdapter {
  readonly kind: EngineKind
  /**
   * 游戏内语言切换能力（供补丁打包与调研文档使用）：
   * native-menu=引擎原生语言菜单（Ren'Py tl/<lang>）；
   * config-toggle=只能改配置切换；
   * injectable-ui=可注入游戏设置 UI 控件（需逐游戏实现）；
   * none=无已知切换途径。
   */
  readonly languageSwitch?: 'native-menu' | 'config-toggle' | 'injectable-ui' | 'none'
  /** 运行时判据（可选；缺省表示引擎无运行时层可探测，如纯文件交付）。 */
  readonly runtime?: EngineRuntime
  detect(gameRoot: string): DetectResult
  extract(gameRoot: string, options?: ExtractOptions): ExtractResult
  inject(gameRoot: string, options: InjectOptions): InjectResult
  diff(gameRoot: string, options: DiffOptions): DiffResult
  coverage(gameRoot: string, options?: CoverageOptions): CoverageReport
}
