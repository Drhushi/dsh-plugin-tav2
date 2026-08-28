/**
 * tl/<lang> 翻译模板生成（M3；移植自 tav2 的 adapters/renpy/templates.py 的
 * write_fallback_templates —— SDK 不可用时的兜底路径，TS 原生实现）。
 *
 * - 对话：按 DialogueUnit.filename（相对 game_dir 的 posix 路径）在 tl/<lang> 下
 *   镜像产出同名 .rpy，每个单元一个 `translate <lang> <identifier>:` 块
 *   （identifier 由解析器按 Ren'Py Restructurer 算法生成，见 fallbackParser）。
 * - 字符串：产出 strings.rpy，`translate <lang> strings:` 下逐条 old/new。
 *
 * 行尾统一用 LF（Ren'Py lexer 两种都接受；Python 在 Windows 上会写 CRLF，属无
 * 语义差异，这里固定 LF 以保证跨平台确定性）。文件名含 ../ 或绝对路径时 fail-closed。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { quoteUnicode } from './compat'
import { DialogueUnit, StringUnit } from './models'
import { parsePythonStringLiteral } from './pystrings'
import { parseTlFile } from './tlparser'

/** _()/_p() 包裹的字符串扫描正则（移植 tav2 templates.py 的 SCAN_STRING_RE）。 */
const SCAN_STRING_RE = /\b_[_p]?\s*(\((?:[\s\\\n]*[uU]?(?:"""(?:\\.|\\\n|"{1,2}|[^\\"])*?"""|'''(?:\\.|\\\n|'{1,2}|[^\\'])*?'''|"(?:\\.|\\\n|[^\\"])*"|'(?:\\.|\\\n|[^\\'])*'))+\s*\))/g

/**
 * renpy.input 提示词扫描正则：捕获 `renpy.input(` 之后的第一个字符串字面量
 * （允许 _()/__() 包裹与 prompt= 关键字；变量/表达式形态不匹配）。
 */
const INPUT_PROMPT_RE = /\brenpy\.input\s*\(\s*(?:(?:__|_)\s*\(\s*|prompt\s*=\s*)?("""(?:\\.|[^\\])*?"""|'''(?:\\.|[^\\])*?'''|"(?:\\.|[^\\])*"|'(?:\\.|[^\\])*')/g

/** _p() 的简化重排：按行去掉首尾空白，空行分隔段落（移植 _reformat_p）。 */
function reformatP(s: string): string {
  const out: string[] = []
  for (const line of s.split('\n')) {
    const stripped = line.trim()
    if (!stripped && out.length > 0 && out[out.length - 1] !== '') out.push('')
    else if (stripped) out.push(stripped)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** 列出 gameDir 下 *.rpy/*.rpym 相对路径（跳过任何层级的 tl/ 目录）。 */
function listRpyFiles(gameDir: string): string[] {
  const out: string[] = []
  const walk = (cur: string, rel: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const full = join(cur, name)
      const childRel = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) {
        if (name === 'tl') continue
        walk(full, childRel)
      } else if (name.endsWith('.rpy') || name.endsWith('.rpym')) {
        out.push(childRel)
      }
    }
  }
  walk(gameDir, '')
  return out
}

/**
 * 兜底字符串扫描：_()/_p() 包裹的字符串（移植 templates.py 的 scan_fallback_strings），
 * 另合并 renpy.input 提示词（裸字符串首参，官方模板不提取、玩家必见），产出
 * writeFallbackTemplates 的 strings 输入。按去重后的值返回 StringUnit 列表。
 */
export function scanFallbackStrings(gameDir: string): StringUnit[] {
  const strings: StringUnit[] = []
  const seen = new Set<string>()
  for (const rel of listRpyFiles(gameDir)) {
    const content = readFileSync(join(gameDir, rel), 'utf8')
    const lines = content.split('\n')
    for (let idx = 0; idx < lines.length; idx += 1) {
      SCAN_STRING_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SCAN_STRING_RE.exec(lines[idx]!)) !== null) {
        const expr = m[1]!.replace(/\\\n/g, '').trim()
        const value = parsePythonStringLiteral(expr)
        if (value === null || value === '') continue
        const finalValue = m[0]!.trimStart().startsWith('_p') ? reformatP(value) : value
        if (seen.has(finalValue)) continue
        seen.add(finalValue)
        strings.push(new StringUnit({ old: finalValue, new: '', filename: rel, linenumber: idx + 1 }))
      }
    }
  }
  for (const prompt of scanInputPrompts(gameDir)) {
    if (seen.has(prompt.old)) continue
    seen.add(prompt.old)
    strings.push(prompt)
  }
  return strings
}

/**
 * renpy.input 提示词扫描：裸字符串（或 _()/__() 包裹）首参提取为可译单元。
 * 官方 translate 模板与 _() 扫描都不覆盖裸形态，是「模板外残留」的典型来源。
 * 变量/表达式形态（非字面量）无法静态提取，返回列表中不含（由收尾对账上报）。
 */
export function scanInputPrompts(gameDir: string): StringUnit[] {
  const prompts: StringUnit[] = []
  const seen = new Set<string>()
  for (const rel of listRpyFiles(gameDir)) {
    const content = readFileSync(join(gameDir, rel), 'utf8')
    const lines = content.split('\n')
    for (let idx = 0; idx < lines.length; idx += 1) {
      INPUT_PROMPT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = INPUT_PROMPT_RE.exec(lines[idx]!)) !== null) {
        const value = parsePythonStringLiteral(m[1]!)
        if (value === null || value === '' || seen.has(value)) continue
        seen.add(value)
        prompts.push(new StringUnit({ old: value, new: '', filename: rel, linenumber: idx + 1 }))
      }
    }
  }
  return prompts
}

/** 校验相对路径安全（拒绝 ../ 与绝对路径），返回可安全拼接的相对路径。 */
function assertSafeRelPath(rel: string): void {
  if (isAbsolute(rel) || rel.includes('\\')) {
    throw new Error(`模板路径不允许绝对路径或反斜杠：${rel}`)
  }
  const parts = rel.split('/')
  if (parts.includes('..') || parts.some((p) => p === '' || p === '.')) {
    throw new Error(`模板路径越界：${rel}`)
  }
}

/** 幂等合并统计（可选的累加器参数；不传时只返回文件清单，行为与旧版一致）。 */
export interface TemplateMergeStats {
  /** 保留的已有块（对话块 + 字符串对，逐字未动）。 */
  preservedBlocks: number
  /** 追加的缺失块（对话块 + 字符串对）。 */
  addedBlocks: number
}

/** 单个对话块的模板行（translate 头 + 注释 + 空译文 say 行，块尾空行）。 */
function dialogueBlockLines(lang: string, unit: DialogueUnit): string[] {
  const lines: string[] = [`translate ${lang} ${unit.identifier}:`, '']
  lines.push(`    # ${unit.filename}:${unit.linenumber}`)
  for (const raw of unit.rawStatements) {
    lines.push(`    # ${raw}`)
    lines.push(`    ${raw}`)
  }
  for (const say of unit.sayLines) {
    lines.push(`    # ${say.raw}`)
    lines.push(`    ${say.render('')}`)
  }
  lines.push('')
  return lines
}

/** 字符串对的模板行（old/new，块尾空行）。 */
function stringsPairLines(strings: StringUnit[]): string[] {
  const lines: string[] = []
  for (const s of strings) {
    lines.push(`    # ${s.filename}:${s.linenumber}`)
    lines.push(`    old "${quoteUnicode(s.old)}"`)
    lines.push('    new ""')
    lines.push('')
  }
  return lines
}

/** 把新块追加到已有文件末尾：去尾部空白后补一个空行分隔，已有内容逐字保留。 */
function appendBlocks(existing: string, append: string): string {
  return `${existing.replace(/\s+$/, '')}\n\n${append}`
}

/**
 * 把解析出的对话/字符串单元写成 tl/<lang> 模板。返回写出的绝对路径清单。
 * strings 为空时不写 strings.rpy。
 *
 * 幂等合并（防数据丢失）：目标文件已存在时不再整体覆盖——按 identifier（对话）
 * / old（字符串）对齐，逐字保留已有已译块，只追加缺失的块；全部已存在时完全不
 * 重写文件。首次生成（文件不存在）行为与旧版逐字一致。合并统计经可选 stats 累加。
 */
export function writeFallbackTemplates(
  gameDir: string,
  lang: string,
  dialogue: DialogueUnit[],
  strings: StringUnit[],
  stats?: TemplateMergeStats,
): string[] {
  const tlDir = join(gameDir, 'tl', lang)
  mkdirSync(tlDir, { recursive: true })
  const written: string[] = []

  const byFile = new Map<string, DialogueUnit[]>()
  for (const unit of dialogue) {
    const list = byFile.get(unit.filename)
    if (list) list.push(unit)
    else byFile.set(unit.filename, [unit])
  }

  for (const [filename, units] of byFile) {
    assertSafeRelPath(filename)
    let target = join(tlDir, ...filename.split('/'))
    if (target.endsWith('.rpym')) target = target.slice(0, -'.rpym'.length) + '.rpy'

    if (!existsSync(target)) {
      // 首次生成：整体新建模板（与旧版逐字一致）
      const lines: string[] = []
      for (const unit of units) lines.push(...dialogueBlockLines(lang, unit))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, lines.join('\n'), 'utf8')
      written.push(target)
      if (stats) stats.addedBlocks += units.length
      continue
    }

    // 幂等合并：保留已有已译块，只追加缺失 identifier 的块（不覆盖、不置空）
    const existing = readFileSync(target, 'utf8')
    const existingIds = new Set(
      parseTlFile(target, lang)
        .filter((c) => c.kind === 'dialogue')
        .map((c) => c.identifier),
    )
    const missing = units.filter((u) => !existingIds.has(u.identifier))
    if (missing.length === 0) {
      if (stats) stats.preservedBlocks += units.length
      continue
    }
    const append: string[] = []
    for (const unit of missing) append.push(...dialogueBlockLines(lang, unit))
    writeFileSync(target, appendBlocks(existing, append.join('\n')), 'utf8')
    written.push(target)
    if (stats) {
      stats.preservedBlocks += units.length - missing.length
      stats.addedBlocks += missing.length
    }
  }

  if (strings.length > 0) {
    const target = join(tlDir, 'strings.rpy')
    if (!existsSync(target)) {
      const lines: string[] = [`translate ${lang} strings:`, '']
      lines.push(...stringsPairLines(strings))
      writeFileSync(target, lines.join('\n'), 'utf8')
      written.push(target)
      if (stats) stats.addedBlocks += strings.length
    } else {
      const existing = readFileSync(target, 'utf8')
      const existingOlds = new Set(
        parseTlFile(target, lang)
          .filter((c) => c.kind === 'strings')
          .flatMap((c) => c.pairs.map((p) => p.old)),
      )
      const missing = strings.filter((s) => !existingOlds.has(s.old))
      if (missing.length === 0) {
        if (stats) stats.preservedBlocks += strings.length
      } else {
        writeFileSync(target, appendBlocks(existing, stringsPairLines(missing).join('\n')), 'utf8')
        written.push(target)
        if (stats) {
          stats.preservedBlocks += strings.length - missing.length
          stats.addedBlocks += missing.length
        }
      }
    }
  }

  return written
}
