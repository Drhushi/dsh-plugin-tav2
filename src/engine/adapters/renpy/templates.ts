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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { quoteUnicode } from './compat'
import { DialogueUnit, StringUnit } from './models'
import { parsePythonStringLiteral } from './pystrings'

/** _()/_p() 包裹的字符串扫描正则（移植 tav2 templates.py 的 SCAN_STRING_RE）。 */
const SCAN_STRING_RE = /\b_[_p]?\s*(\((?:[\s\\\n]*[uU]?(?:"""(?:\\.|\\\n|"{1,2}|[^\\"])*?"""|'''(?:\\.|\\\n|'{1,2}|[^\\'])*?'''|"(?:\\.|\\\n|[^\\"])*"|'(?:\\.|\\\n|[^\\'])*'))+\s*\))/g

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
 * 产出 writeFallbackTemplates 的 strings 输入。按去重后的值返回 StringUnit 列表。
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
  return strings
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

/**
 * 把解析出的对话/字符串单元写成 tl/<lang> 模板。返回写出的绝对路径清单。
 * strings 为空时不写 strings.rpy。
 */
export function writeFallbackTemplates(
  gameDir: string,
  lang: string,
  dialogue: DialogueUnit[],
  strings: StringUnit[],
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
    const lines: string[] = []
    for (const unit of units) {
      lines.push(`translate ${lang} ${unit.identifier}:`)
      lines.push('')
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
    }
    let target = join(tlDir, ...filename.split('/'))
    if (target.endsWith('.rpym')) target = target.slice(0, -'.rpym'.length) + '.rpy'
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, lines.join('\n'), 'utf8')
    written.push(target)
  }

  if (strings.length > 0) {
    const lines: string[] = [`translate ${lang} strings:`, '']
    for (const s of strings) {
      lines.push(`    # ${s.filename}:${s.linenumber}`)
      lines.push(`    old "${quoteUnicode(s.old)}"`)
      lines.push('    new ""')
      lines.push('')
    }
    const target = join(tlDir, 'strings.rpy')
    writeFileSync(target, lines.join('\n'), 'utf8')
    written.push(target)
  }

  return written
}
