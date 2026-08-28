/**
 * 字体落地补丁（纯 TS，离线）：pick 计划（只读）→ 写盘（复制字体 + 样式覆盖 + config 记录）。
 *
 * 非侵入契约：只往 tl/<lang>/font/ 写新增文件 + 更新项目 config.yaml，绝不改原游戏文件。
 * - 样式覆盖 fonts.rpy 采用「translate <lang> python: 设 gui 字体」的按语言条件写法（配方 §4.1）。
 * - fail-closed：写覆盖前必须先在游戏源码确认 gui.text_font 存在；确认不了只复制字体不写 rpy。
 * - 幂等替换：重复 pick 先清 tl/<lang>/font/ 下旧字体文件与覆盖，再写新字体。
 */
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import yaml from 'js-yaml'
import { tlRoot } from '../adapters/renpy/tlparser'
import { resolveGameDir, sanitizeStem, FONT_EXTENSIONS, isRiskyFont } from './scan'
import { readFontMeta } from './ttf'

export const FONT_DIR = 'font'
export const STYLE_OVERRIDE_FILE = 'fonts.rpy'

export interface FontPickPlan {
  lang: string
  /** tl/<lang>/font 绝对目录 */
  fontDir: string
  /** 复制后的字体文件名（净化 stem + 扩展名） */
  fontFile: string
  /** 字体文件写入绝对路径 */
  fontPath: string
  /** 样式覆盖 rpy 绝对路径 */
  rpyPath: string
  /** 字体源文件绝对路径 */
  source: string
  /** config.yaml 绝对路径 */
  configPath: string
  /** 将写入的 fonts 段（yaml 文本，供审批预览） */
  configBlock: string
  /** 记录进 config 的值 */
  values: { default: string; map: Record<string, string> }
  /** 重复 pick 时要清理的旧文件（绝对路径） */
  replaces: string[]
  /** 新字体是否命中版权风险黑名单 */
  risky: boolean
  /** 展示名 */
  name: string
}

/** 生成按语言条件的样式覆盖内容（配方 §4.1）。 */
export function buildFontsRpy(lang: string, fontRel: string): string {
  return [
    `# tav2 字体补丁（由 tav2_font 生成，勿手改；删除本文件与 tl/${lang}/font/ 下字体即可还原）`,
    `translate ${lang} python:`,
    `    gui.text_font = "${fontRel}"`,
    `    gui.name_text_font = gui.text_font`,
    `    gui.interface_text_font = gui.text_font`,
    `    gui.choice_button_text_font = gui.text_font`,
    `    gui.button_text_font = gui.interface_text_font`,
    `    gui.system_font = "${fontRel}"`,
    '',
  ].join('\n')
}

/**
 * 在游戏源码 .rpy 中确认 gui.text_font 赋值是否存在（fail-closed 前置）。
 * 编译版（.rpa/.rpyc）游戏目录里没有 .rpy 源码——调用方应把 Python prepare
 * 暂存区的反编译源码目录（<staging>/game）传入 extraSourceDirs 作为确认来源，
 * 否则纯编译游戏永远确认不到，样式覆盖恒被 fail-closed 拦下。
 */
export function confirmGuiTextFont(gameDir: string, extraSourceDirs: readonly string[] = []): boolean {
  const re = /gui\.text_font\s*=/
  const walk = (dir: string): boolean => {
    let entries: { name: string; isDir: boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }))
    } catch {
      return false
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDir) {
        if (entry.name === 'tl' || entry.name === 'renpy') continue
        if (walk(full)) return true
      } else if (entry.name.endsWith('.rpy')) {
        try {
          if (re.test(readFileSync(full, 'utf8'))) return true
        } catch {
          // 单个文件不可读跳过
        }
      }
    }
    return false
  }
  return walk(resolveGameDir(gameDir)) || extraSourceDirs.some((dir) => walk(dir))
}

/** 读取 config.yaml 中已记录的 fonts 段（只读，缺失/损坏返回空）。 */
export function readConfigFonts(configPath: string): {
  enabled?: boolean
  default?: string
  map?: Record<string, string>
  dir?: string
} {
  try {
    const raw = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null
    const fonts = (raw?.fonts ?? {}) as Record<string, unknown>
    const map: Record<string, string> = {}
    if (fonts.map && typeof fonts.map === 'object') {
      for (const [k, v] of Object.entries(fonts.map as Record<string, unknown>)) map[k] = String(v)
    }
    return {
      enabled: typeof fonts.enabled === 'boolean' ? fonts.enabled : undefined,
      default: typeof fonts.default === 'string' ? fonts.default : undefined,
      ...(Object.keys(map).length > 0 ? { map } : {}),
      dir: typeof fonts.dir === 'string' ? fonts.dir : undefined,
    }
  } catch {
    return {}
  }
}

/** 生成 fonts 段文本（保留既有 enabled/dir；default/map 为新值）。 */
export function buildConfigBlock(
  values: { default: string; map: Record<string, string> },
  existing: { enabled?: boolean; dir?: string },
): string {
  const enabled = existing.enabled ?? true
  const dir = existing.dir ?? ''
  const mapLines = Object.entries(values.map).map(([k, v]) => `    ${k}: ${v}`)
  return [
    'fonts:',
    `  enabled: ${String(enabled)}`,
    `  default: ${values.default}`,
    '  map:',
    ...(mapLines.length > 0 ? mapLines : ['    {}']),
    `  dir: ${dir ? String(dir) : "''"}`,
  ].join('\n')
}

/** 把 fonts 段写回 config.yaml（文本级替换该段，保留其它顶层键与注释）。 */
export function updateConfigFonts(configPath: string, block: string): void {
  const text = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.trim() === 'fonts:')
  if (idx === -1) {
    const sep = text.endsWith('\n') ? '' : '\n'
    writeFileSync(configPath, `${text}${sep}${block}\n`, 'utf8')
    return
  }
  // 块终点 = 第一个非空且不缩进的行（即下一个顶层键/文件尾）。
  let end = idx + 1
  while (end < lines.length && (lines[end]!.trim() === '' || /^\s/.test(lines[end]!))) end += 1
  const updated = [...lines.slice(0, idx), ...block.split('\n'), ...lines.slice(end)].join('\n')
  writeFileSync(configPath, updated, 'utf8')
}

/** 只读规划 pick（不写盘）。 */
export function buildFontPickPlan(
  gameDir: string,
  configPath: string,
  sourcePath: string,
  lang: string,
): FontPickPlan {
  const stem = sanitizeStem(sourcePath)
  const ext = extname(sourcePath).toLowerCase()
  const fontFile = `${stem}${ext}`
  const fontDir = join(tlRoot(gameDir, lang), FONT_DIR)
  const fontPath = join(fontDir, fontFile)
  const rpyPath = join(fontDir, STYLE_OVERRIDE_FILE)

  // 旧文件清理清单（幂等替换）：该目录下既有字体文件 + 样式覆盖。
  const replaces: string[] = []
  if (existsSync(fontDir)) {
    for (const f of readdirSync(fontDir)) {
      const full = join(fontDir, f)
      if (f === STYLE_OVERRIDE_FILE || FONT_EXTENSIONS.includes(extname(f).toLowerCase())) replaces.push(full)
    }
  }

  const meta = readFontMeta(sourcePath)
  const values = { default: stem, map: { [stem]: `font/${fontFile}` } }
  const existing = readConfigFonts(configPath)
  return {
    lang,
    fontDir,
    fontFile,
    fontPath,
    rpyPath,
    source: sourcePath,
    configPath,
    configBlock: buildConfigBlock(values, existing),
    values,
    replaces,
    risky: isRiskyFont(basename(sourcePath)),
    name: meta?.fullName || meta?.family || stem,
  }
}

export interface FontPickApplied {
  files: string[]
  degraded: boolean
  note: string
}

/** 写盘执行 pick（调用方需已通过审批）。 */
export function applyFontPick(plan: FontPickPlan, confirmVars: boolean): FontPickApplied {
  const files: string[] = []

  // 1. 清理旧文件（幂等替换；单个失败不阻断）。
  for (const f of plan.replaces) {
    try {
      rmSync(f, { force: true })
    } catch {
      // ignore
    }
  }

  // 2. 复制新字体。
  mkdirSync(plan.fontDir, { recursive: true })
  copyFileSync(plan.source, plan.fontPath)
  files.push(plan.fontPath)

  // 3. 样式覆盖（fail-closed）。
  let degraded = false
  let note = ''
  if (confirmVars) {
    const fontRel = `tl/${plan.lang}/font/${plan.fontFile}`
    writeFileSync(plan.rpyPath, buildFontsRpy(plan.lang, fontRel), 'utf8')
    files.push(plan.rpyPath)
  } else {
    degraded = true
    note = '未能在游戏源码确认 gui.text_font 等样式变量，未生成样式覆盖（只复制了字体）；请按 RENPY-LANGUAGE-SWITCH-RECIPE 手动接入，或用 tav2_verify 核对字体是否生效。'
  }

  // 4. 记录选择进 config.yaml。
  updateConfigFonts(plan.configPath, plan.configBlock)
  files.push(plan.configPath)

  return { files, degraded, note }
}
