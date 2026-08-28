/**
 * Ren'Py 适配器（Phase 0）。
 *
 * 复用已有 tlparser / backfill / verify 模块，把它们统一到
 * EngineAdapter 接口：detect / extract / inject / diff / coverage。
 */
import { createHash } from 'node:crypto'
import { Dirent, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { sourceHash } from '../../db'
import { Document, Scene, Unit } from '../../models'
import { backfillMachine } from './backfill'
import { DialogueUnit, StringUnit } from './models'
import { parseDialogueUnits } from './fallbackParser'
import { resolveSourceGameDirs } from './sourceDir'
import { loadWork, parseTlDirectory, tlRoot } from './tlparser'
import { verifyRenpy } from './verify'
import { renpyRuntime } from './runtime'
import type {
  CoverageOptions,
  CoverageReport,
  DetectResult,
  DiffOptions,
  DiffResult,
  EngineAdapter,
  ExtractOptions,
  ExtractResult,
  InjectOptions,
  InjectResult,
} from '../types'

/** 探测时跳过的目录：产物/运行时目录，避免把 tl/ 翻译模板、缓存当源码。 */
const DETECT_SKIP_DIRS = new Set(['tl', 'cache', 'renpy', '__pycache__'])

/** 递归统计 dir 下 .rpy/.rpyc/.rpa 数量（跳过产物目录；目录不可读静默跳过）。 */
function countRenpySources(root: string, out: { rpy: number; rpyc: number; rpa: number }): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (DETECT_SKIP_DIRS.has(e.name)) continue
      countRenpySources(join(root, e.name), out)
      continue
    }
    if (e.name.endsWith('.rpy')) out.rpy++
    else if (e.name.endsWith('.rpyc')) out.rpyc++
    else if (e.name.endsWith('.rpa')) out.rpa++
  }
}

/** Ren'Py 探测：存在 game/ 且含 .rpy/.rpyc/.rpa（含深层子目录），或存在 game/tl/<lang>。 */
export function detectRenpy(gameRoot: string): DetectResult {
  const gameDir = join(gameRoot, 'game')
  const hasGameDir = existsSync(gameDir) && statSync(gameDir).isDirectory()
  // 递归统计源文件（真实游戏脚本常放在 game/script/ 等子目录，不再只认直接子项）。
  const counts = { rpy: 0, rpyc: 0, rpa: 0 }
  if (hasGameDir || existsSync(gameRoot)) {
    countRenpySources(hasGameDir ? gameDir : gameRoot, counts)
  }
  const tlChinese = hasGameDir && existsSync(join(gameDir, 'tl', 'chinese'))

  const detected = hasGameDir && (counts.rpy > 0 || counts.rpyc > 0 || counts.rpa > 0 || tlChinese)
  const confidence = detected ? (tlChinese ? 1 : 0.8) : 0
  return {
    engine: 'renpy',
    detected,
    gameRoot,
    confidence,
    layout: {
      gameDir: hasGameDir ? gameDir : null,
      rpyCount: counts.rpy,
      rpycCount: counts.rpyc,
      rpaCount: counts.rpa,
      hasTlChinese: Boolean(tlChinese),
    },
    message: detected
      ? `检测到 Ren'Py 游戏（.rpy=${counts.rpy}, .rpyc=${counts.rpyc}, .rpa=${counts.rpa}）`
      : "未检测到 Ren'Py 游戏布局",
  }
}

function dialogueTranslated(unit: DialogueUnit): boolean {
  const lines = unit.sayLines.filter((say) => (say.originalWhat ?? say.what).trim())
  if (lines.length === 0) return true
  return lines.every(
    (say) => Boolean(say.what.trim()) && say.originalWhat !== null && say.what !== say.originalWhat,
  )
}

/** 分支名：label 下划线前缀；无下划线或空 label 归 main（与 Python _branch_for 对齐）。 */
function branchFor(label: string | null): string {
  if (label && label.includes('_')) {
    const head = label.split('_', 1)[0]
    if (head) return head
  }
  return 'main'
}

/**
 * 把 tl/<lang> 的对话块和字符串块归一化为 Document。
 * unit_id / extra 与 Python 基线 tav2/adapters/renpy/adapter.py 对齐；
 * 当前 TS 侧尚未移植 label 映射，label 暂按 noaddr 处理。
 */
export function extractRenpy(gameRoot: string, options: ExtractOptions = {}): ExtractResult {
  const lang = options.lang ?? 'chinese'
  const [, dialogue, strings] = loadWork(gameRoot, lang)
  // 标识符 -> label 映射来自游戏脚本解析（与 Python adapter._label_map 对齐）；
  // 编译版游戏目录没有松散 .rpy，自动回退到源码参考目录（tav2_src）解析；
  // 脚本缺失或解析失败时退化为按文件分组（noaddr）。
  const labelMap = new Map<string, string>()
  for (const dir of [gameRoot, ...resolveSourceGameDirs(gameRoot)]) {
    try {
      for (const unit of parseDialogueUnits(dir)) {
        if (unit.label) labelMap.set(unit.identifier, unit.label)
      }
    } catch {
      // 忽略：退化为 noaddr
    }
  }
  const detectBranch = options.branchDetect ?? true
  const scenes: Scene[] = []
  const sceneById = new Map<string, Scene>()

  function sceneFor(file: string, label: string | null): Scene {
    const sceneId = `${file}::${label ?? 'noaddr'}`
    let scene = sceneById.get(sceneId)
    if (!scene) {
      const branch = detectBranch ? branchFor(label) : 'main'
      scene = new Scene(
        sceneId,
        label ? `${file}#${label}` : file,
        0,
        [],
        branch,
        { filename: file },
      )
      sceneById.set(sceneId, scene)
      scenes.push(scene)
    }
    return scene
  }

  for (const unit of [...dialogue].sort((a, b) =>
    a.filename.localeCompare(b.filename) || a.linenumber - b.linenumber)) {
    const scene = sceneFor(unit.filename, labelMap.get(unit.identifier) ?? null)
    const translated = dialogueTranslated(unit)
    for (let sayIndex = 0; sayIndex < unit.sayLines.length; sayIndex += 1) {
      const say = unit.sayLines[sayIndex]!
      const source = (say.originalWhat ?? say.what).trim()
      if (!source) continue
      scene.units.push(new Unit(
        `${unit.identifier}#${sayIndex}`,
        'dialogue',
        source,
        '',
        say.who ?? '',
        scene.scene_id,
        [],
        {
          file: unit.filename,
          identifier: unit.identifier,
          say_index: sayIndex,
          block: true,
          translated,
        },
      ))
    }
  }

  const stringSceneByFile = new Map<string, Scene>()
  for (const unit of [...strings].sort((a, b) =>
    a.filename.localeCompare(b.filename) || a.linenumber - b.linenumber)) {
    let scene = stringSceneByFile.get(unit.filename)
    if (!scene) {
      scene = new Scene(`strings::${unit.filename}`, `strings:${unit.filename}`, 0, [], 'main')
      stringSceneByFile.set(unit.filename, scene)
      scenes.push(scene)
    }
    scene.units.push(new Unit(
      `S:${sourceHash(unit.old)}`,
      'string',
      unit.old,
      '',
      '',
      scene.scene_id,
      [],
      { file: unit.filename, old: unit.old, translated: unit.isTranslated },
    ))
  }

  scenes.forEach((scene, index) => {
    scene.order = index
    for (const unit of scene.units) unit.scene_id = scene.scene_id
  })

  const files = parseTlDirectory(gameRoot, lang).map(([path]) =>
    relative(tlRoot(gameRoot, lang), path).split(sep).join('/'))
  const document = new Document('renpy', gameRoot, lang, scenes, {})
  return {
    document,
    files,
    warnings: [],
    counts: { scenes: scenes.length, units: document.allUnits().length },
  }
}

/** 供世界书/术语扫描用的原文行（含 [文件:行号] 前缀，与 Python scan_lines 对齐）。 */
export function scanLinesRenpy(gameRoot: string, lang = 'chinese'): string[] {
  const [, dialogue, strings] = loadWork(gameRoot, lang)
  const out: string[] = []
  for (const unit of [...dialogue].sort((a, b) =>
    a.filename.localeCompare(b.filename) || a.linenumber - b.linenumber)) {
    for (const say of unit.sayLines) {
      const text = (say.originalWhat ?? say.what).trim()
      if (text) out.push(`[${unit.filename}:${unit.linenumber}] ${text}`)
    }
  }
  for (const unit of [...strings].sort((a, b) =>
    a.filename.localeCompare(b.filename) || a.linenumber - b.linenumber)) {
    if (unit.old.trim()) out.push(`[${unit.filename}:${unit.linenumber}] ${unit.old}`)
  }
  return out
}

/** 把 runTranslate 产出的 unit_id -> 译文转换为 backfill 所需结构并写回 tl。 */
export function injectDocumentTranslations(
  gameRoot: string,
  document: Document,
  translations: Record<string, string>,
  lang = 'chinese',
): InjectResult {
  const dialogueMap: Record<string, Record<string, string>> = {}
  const stringMap: Record<string, string> = {}
  for (const unit of document.allUnits()) {
    const translation = translations[unit.unit_id]
    if (translation === undefined || translation === null) continue
    const file = String(unit.extra.file ?? '')
    if (!file) continue
    if (unit.kind === 'string') {
      stringMap[`${file}|${String(unit.extra.old ?? '')}`] = translation
    } else {
      const identifier = String(unit.extra.identifier ?? '')
      const sayIndex = String(unit.extra.say_index ?? '0')
      if (!identifier) continue
      dialogueMap[`${file}|${identifier}`] ??= {}
      dialogueMap[`${file}|${identifier}`]![sayIndex] = translation
    }
  }
  return injectRenpy(gameRoot, { lang, dialogueMap, stringMap })
}

/** 回写 tl/<lang>；dryRun 暂以报告形式提示（后续可做临时副本验证）。 */
export function injectRenpy(gameRoot: string, options: InjectOptions): InjectResult {
  const lang = options.lang ?? 'chinese'
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      applied: 0,
      skipped: 0,
      unchanged: 0,
      files: [],
      warnings: ['dryRun 模式尚未执行真实写盘，仅作接口占位'],
    }
  }

  const dialogueMap = (options.dialogueMap ?? {}) as never
  const stringMap = (options.stringMap ?? {}) as never
  const stats = backfillMachine(gameRoot, lang, dialogueMap, stringMap)
  return {
    ok: true,
    dryRun: false,
    applied: stats.applied,
    skipped: stats.skipped,
    unchanged: stats.unchanged,
    files: [],
    warnings: [],
  }
}

function collectRpyFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRpyFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.rpy')) out.push(full)
  }
  return out
}

function fileHash(path: string): string {
  const text = readFileSync(path, 'utf8')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 对比两个 Ren'Py tl 目录：按相对路径 + 内容 hash 区分新增/修改/删除。 */
export function diffRenpy(_gameRoot: string, options: DiffOptions): DiffResult {
  const lang = options.lang ?? 'chinese'
  const fromRoot = tlRoot(options.fromRoot, lang)
  const toRoot = tlRoot(options.toRoot, lang)

  const fromFiles = new Map(collectRpyFiles(fromRoot).map((p) => [
    relative(fromRoot, p).split(sep).join('/'),
    fileHash(p),
  ]))
  const toFiles = new Map(collectRpyFiles(toRoot).map((p) => [
    relative(toRoot, p).split(sep).join('/'),
    fileHash(p),
  ]))

  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []

  for (const [rel, hash] of toFiles) {
    if (!fromFiles.has(rel)) added.push(rel)
    else if (fromFiles.get(rel) !== hash) modified.push(rel)
    else unchanged.push(rel)
  }
  for (const rel of fromFiles.keys()) {
    if (!toFiles.has(rel)) removed.push(rel)
  }

  return { added: added.sort(), modified: modified.sort(), removed: removed.sort(), unchanged: unchanged.sort() }
}

/** Ren'Py 覆盖率：基于 verifyRenpy 的 missing_ids 计算。 */
export function coverageRenpy(gameRoot: string, options: CoverageOptions = {}): CoverageReport {
  const lang = options.lang ?? 'chinese'
  const report = verifyRenpy(gameRoot, lang, options.expectedBlocks)
  const total = report.expected_blocks
  const covered = Math.max(0, total - report.missing_blocks)
  return {
    total,
    covered,
    missing: report.missing_blocks,
    missingIds: report.missing_ids,
    coverageRatio: total > 0 ? covered / total : 1,
    details: report as unknown as Record<string, unknown>,
  }
}

export const renpyAdapter: EngineAdapter = {
  kind: 'renpy',
  languageSwitch: 'native-menu',
  detect: detectRenpy,
  extract: extractRenpy,
  inject: injectRenpy,
  diff: diffRenpy,
  coverage: coverageRenpy,
  runtime: renpyRuntime,
}
