/**
 * 翻译工作台 /tav2/panel HTTP 路由：只读，按 dir 解析项目并返回面板快照 JSON。
 * - loopback Host 守卫（防 DNS rebinding 经本路由读项目数据）+ dir 白名单
 *   （真实存在且含 config.yaml 才处理）。
 * - 结构化错误：no-project / multiple-projects / not-initialized / error。
 * - 引擎非 renpy 由 loadEngineConfig + assertSupportedEngine fail-closed 报错。
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, dirname, join } from 'node:path'
import { assertSupportedEngine, loadEngineConfig, resolveProjectDbPath } from '../engine/config'
import type { EngineConfig } from '../engine/config'
import { discoverConfigProjects } from '../engine/discover'
import { ProjectDB } from '../engine/db'
import { renpyAdapter } from '../engine/adapters'
import { panelSnapshot, readRunPromptDirs, readRunPromptTail, readRunPrompts, sceneUnitList } from '../engine/panel'
import { sessionProjectOverride, sessionGameOverride } from './select_project'

/** 解析出的项目三要素。 */
export interface ResolvedPanelProject {
  configPath: string
  projectDir: string
  engineCfg: EngineConfig
}

export type ResolvePanelProjectResult =
  | { ok: true; project: ResolvedPanelProject }
  | { ok: false; code: 'no-project' | 'multiple-projects' | 'error'; message: string; candidates?: string[] }

/** 路由响应：HTTP 状态 + JSON 载荷。 */
export interface PanelRouteResponse {
  status: number
  json: Record<string, unknown>
}

/** HTTP 响应最小面（handler 直测用）。 */
interface HttpLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** 仅放行回环 Host；缺省/外部一律拒绝（防 DNS rebinding 通过本路由读项目数据）。 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    hostname = end === -1 ? hostname : hostname.slice(1, end)
  } else {
    const colon = hostname.lastIndexOf(':')
    if (colon !== -1) hostname = hostname.slice(0, colon)
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/**
 * 从 dir 解析项目：dir/config.yaml 优先，否则有界递归（最多 3 层）发现唯一子项目；
 * 多个候选不自动选，返回绝对路径列表供面板切换。
 */
export function resolvePanelProject(dir: string): ResolvePanelProjectResult {
  if (!dir || !isAbsolute(dir)) {
    return { ok: false, code: 'no-project', message: 'dir 缺失或不是绝对路径' }
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, code: 'no-project', message: `目录不存在：${dir}` }
  }
  const found = discoverConfigProjects(dir)
  const rootHit = found.find((p) => p.depth === 0)
  if (rootHit) return loadProjectAt(rootHit.dir, rootHit.configPath)
  const subs = found.filter((p) => p.depth > 0)
  if (subs.length === 1) {
    const sub = subs[0]!
    return loadProjectAt(sub.dir, sub.configPath)
  }
  if (subs.length > 1) {
    const candidates = subs.map((p) => p.dir)
    return {
      ok: false,
      code: 'multiple-projects',
      message: `工作区下发现 ${candidates.length} 个候选项目，请在面板选择或 tav2_select_project 切换`,
      candidates,
    }
  }
  return { ok: false, code: 'no-project', message: '该目录下未找到 config.yaml（无翻译项目）。请先在对话里「初始化游戏翻译」。' }
}

function loadProjectAt(projectDir: string, configPath: string): ResolvePanelProjectResult {
  try {
    const engineCfg = loadEngineConfig(configPath, projectDir)
    assertSupportedEngine(engineCfg)
    return { ok: true, project: { configPath, projectDir, engineCfg } }
  } catch (err) {
    return { ok: false, code: 'error', message: String(err instanceof Error ? err.message : err) }
  }
}

/**
 * 会话感知的项目解析（panel 各路由共用）：
 * 会话级项目选择优先（无效则静默回退 dir 发现）；游戏目录覆盖（_prep 暂存项目）
 * 由调用方在拿到 engineCfg 后按需应用（覆盖会改写 engineCfg.gameDir）。
 */
function resolveSessionProject(dir: string, sessionKey: string | undefined): ResolvePanelProjectResult {
  if (sessionKey) {
    const sel = sessionProjectOverride(sessionKey)
    if (sel) {
      const r = resolvePanelProject(sel)
      if (r.ok) return r
    }
  }
  return resolvePanelProject(dir)
}

/** 项目解析失败 → 统一结构化错误 JSON（保留 candidates）。 */
function resolveFailureJson(resolved: Extract<ResolvePanelProjectResult, { ok: false }>): Record<string, unknown> {
  const json: Record<string, unknown> = { ok: false, code: resolved.code, message: resolved.message }
  if (resolved.candidates) json.candidates = resolved.candidates
  return json
}

/** 路由核心：dir + 可选 session → 面板快照或结构化错误（不涉及 HTTP 层，可直接单测）。 */
export function panelRouteFor(dir: string, sessionKey?: string): PanelRouteResponse {
  try {
    const resolved = resolveSessionProject(dir, sessionKey)
    if (!resolved.ok) {
      return { status: 200, json: resolveFailureJson(resolved) }
    }
    const { engineCfg, configPath, projectDir } = resolved.project
    // 会话级「游戏目录」覆盖（select_project 的游戏目录语义，如编译版 _prep 暂存项目）：
    // DB 路径按 basename(gameDir) 解析，覆盖后指向 projects/<游戏名>_prep，tl 提取也读暂存区；
    // 不覆盖的话面板永远显示原项目的空 DB，工作台看起来「不随内容更新」。
    const gameOverride = sessionKey ? sessionGameOverride(sessionKey) : undefined
    if (gameOverride) engineCfg.gameDir = gameOverride
    const dbPath = resolveProjectDbPath(engineCfg, configPath, projectDir)
    if (!existsSync(dbPath)) {
      return {
        status: 200,
        json: {
          ok: false,
          code: 'not-initialized',
          message: 'config.yaml 已就绪，但项目尚未初始化（无 db.sqlite）。请先对助手说「初始化游戏翻译」。',
        },
      }
    }
    const document = renpyAdapter.extract(engineCfg.gameDir, { lang: engineCfg.lang }).document
    const db = new ProjectDB(dbPath)
    try {
      const snapshotDir = engineCfg.debug.requestSnapshotDir.trim() || join(dirname(dbPath), 'requests')
      const panel = panelSnapshot(db, document, snapshotDir)
      // 项目标识 + 候选列表（母文件夹多游戏时供面板常驻切换器）：
      // 当前项目名 = 配置目录名；候选 = dir 下发现的其他 config 项目 + 当前项目（去重）。
      const name = projectDir.split(/[\\/]/).filter(Boolean).pop() || projectDir
      const candidates = discoverConfigProjects(dir)
        .map((p) => p.dir)
        .filter((d) => d !== projectDir)
      return {
        status: 200,
        json: {
          ok: true,
          project: { name, dir: projectDir, lang: engineCfg.lang },
          projects: [projectDir, ...candidates],
          panel,
        },
      }
    } finally {
      db.close()
    }
  } catch (err) {
    return { status: 200, json: { ok: false, code: 'error', message: String(err instanceof Error ? err.message : err) } }
  }
}

/**
 * 按 runId 取 recording 快照（/tav2/panel/prompts 数据源；只读）。
 * 项目解析逻辑与 panelRouteFor 一致；runId 缺失 → 400。
 * opts.tail=true 时返回最后 n 条（实时活动流轮询用），缺省保持前 50 条（事后查看）。
 */
export function promptRouteFor(
  dir: string,
  sessionKey: string | undefined,
  runId: string,
  opts: { tail?: boolean; n?: number } = {},
): PanelRouteResponse {
  if (!runId) return { status: 400, json: { ok: false, code: 'error', message: '缺少 runId' } }
  try {
    const resolved = resolveSessionProject(dir, sessionKey)
    if (!resolved.ok) {
      return { status: 200, json: resolveFailureJson(resolved) }
    }
    const { engineCfg } = resolved.project
    // 与 panelRouteFor 一致：跟随会话级游戏目录覆盖（_prep 暂存项目的快照目录在
    // projects/<游戏名>_prep/requests 下）。
    const gameOverride = sessionKey ? sessionGameOverride(sessionKey) : undefined
    if (gameOverride) engineCfg.gameDir = gameOverride
    const dbPath = resolveProjectDbPath(engineCfg, resolved.project.configPath, resolved.project.projectDir)
    const snapshotDir = engineCfg.debug.requestSnapshotDir.trim() || join(dirname(dbPath), 'requests')
    if (!snapshotDir) return { status: 200, json: { ok: true, prompts: [] } }
    const mapping = readRunPromptDirs(snapshotDir, [{ run_id: runId }])
    const fileName = mapping[runId]
    if (!fileName) return { status: 200, json: { ok: true, prompts: [] } }
    if (opts.tail) {
      const n = Math.max(1, Math.min(100, Math.round(Number(opts.n) || 30)))
      const prompts = readRunPromptTail(snapshotDir, fileName, n)
      return { status: 200, json: { ok: true, prompts } }
    }
    const prompts = readRunPrompts(snapshotDir, fileName)
    return { status: 200, json: { ok: true, prompts } }
  } catch (err) {
    return { status: 200, json: { ok: false, code: 'error', message: String(err instanceof Error ? err.message : err) } }
  }
}

/**
 * 按场景取单元明细（/tav2/panel/scene-units 数据源；只读，进度明细点开后懒加载）。
 * 项目解析与 panelRouteFor 同一套（会话覆盖 + 游戏目录覆盖），DB 未初始化返回结构化错误。
 */
export function sceneUnitsRouteFor(
  dir: string,
  sessionKey: string | undefined,
  sceneId: string,
): PanelRouteResponse {
  if (!sceneId) return { status: 400, json: { ok: false, code: 'error', message: '缺少 sceneId' } }
  try {
    const resolved = resolveSessionProject(dir, sessionKey)
    if (!resolved.ok) {
      return { status: 200, json: resolveFailureJson(resolved) }
    }
    const { engineCfg, configPath, projectDir } = resolved.project
    // 与 panelRouteFor 一致：跟随会话级游戏目录覆盖（_prep 暂存项目，tl 提取读暂存区）。
    const gameOverride = sessionKey ? sessionGameOverride(sessionKey) : undefined
    if (gameOverride) engineCfg.gameDir = gameOverride
    const dbPath = resolveProjectDbPath(engineCfg, configPath, projectDir)
    if (!existsSync(dbPath)) {
      return {
        status: 200,
        json: { ok: false, code: 'not-initialized', message: '项目尚未初始化（无 db.sqlite）。请先对助手说「初始化游戏翻译」。' },
      }
    }
    const document = renpyAdapter.extract(engineCfg.gameDir, { lang: engineCfg.lang }).document
    const db = new ProjectDB(dbPath)
    try {
      const found = sceneUnitList(db, document, sceneId)
      if (!found) {
        return { status: 200, json: { ok: false, code: 'no-scene', message: `场景不存在：${sceneId}` } }
      }
      return { status: 200, json: { ok: true, sceneId, title: found.title, units: found.units } }
    } finally {
      db.close()
    }
  } catch (err) {
    return { status: 200, json: { ok: false, code: 'error', message: String(err instanceof Error ? err.message : err) } }
  }
}

/** webServer 路由注册最小面（真实宿主传入完整服务）。 */
interface PanelWebServer {
  register?: (route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => unknown
}

/** 注册一条 /tav2/panel* 只读 GET 路由：统一 loopback Host 守卫 + 查询串解析，handler 返回响应。 */
function registerPanelGetRoute(
  webServer: PanelWebServer,
  path: string,
  handle: (params: URLSearchParams) => PanelRouteResponse,
): void {
  if (!webServer?.register) {
    console.warn(`[dsh-plugin-tav2] webServer 服务不可用，跳过 ${path} 路由注册`)
    return
  }
  webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const httpRes = res as HttpLike
      const httpReq = req as { headers?: { host?: string }; url?: string }
      if (!isLoopbackHost(httpReq.headers?.host)) {
        httpRes.writeHead(403)
        httpRes.end('forbidden')
        return
      }
      const url = new URL(httpReq.url ?? '/', 'http://localhost')
      const result = handle(url.searchParams)
      httpRes.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
      httpRes.end(JSON.stringify(result.json))
    },
  })
}

/** 注册 /tav2/panel 只读路由族（webServer 服务缺失时告警跳过，不阻塞插件）。 */
export function registerPanelRoute(ctx: Context): void {
  const webServer = (ctx as unknown as { get?: (name: string) => unknown }).get?.('webServer') as PanelWebServer | undefined
  if (!webServer?.register) {
    console.warn('[dsh-plugin-tav2] webServer 服务不可用，跳过 /tav2/panel 路由注册')
    return
  }
  // /tav2/panel：面板全量快照（状态带 / 待办 / 世界书 / 进度 / 过程）。
  registerPanelGetRoute(webServer, '/tav2/panel', (params) =>
    panelRouteFor(params.get('dir') ?? '', params.get('session') || undefined))
  // /tav2/panel/prompts：按 runId 拉取该次运行的 recording 快照（system + messages）。
  // tail=1&n=N：实时活动流轮询（最后 N 条）；缺省保持事后查看语义（前 50 条）。
  registerPanelGetRoute(webServer, '/tav2/panel/prompts', (params) =>
    promptRouteFor(
      params.get('dir') ?? '',
      params.get('session') || undefined,
      params.get('runId') ?? '',
      { tail: params.get('tail') === '1', n: Number(params.get('n') ?? '') || undefined },
    ))
  // /tav2/panel/scene-units：进度明细点开后的单场景单元明细（懒加载）。
  registerPanelGetRoute(webServer, '/tav2/panel/scene-units', (params) =>
    sceneUnitsRouteFor(
      params.get('dir') ?? '',
      params.get('session') || undefined,
      params.get('sceneId') ?? '',
    ))
}
