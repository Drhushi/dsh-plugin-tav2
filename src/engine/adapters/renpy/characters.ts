/**
 * 说话人识别：从反编译源码提取角色定义（who 简写 → 显示名）。
 * 移植自 Python tav2/adapters/renpy/characters.py（保留核心逻辑与注释）。
 * 只做只读解析，不改写任何游戏文件；输出作为世界书「必翻人名」种子来源。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 匹配 `define x = Character("Name")` / `$ x = Character(_("Name"))` / None / game_state.player_name。 */
const CHAR_RE = /(?:^|\n)\s*(?:define|\$)\s+(\w+)\s*=\s*Character\(\s*(?:"([^"]*)"|_\("([^"]*)"\)|None|game_state\.player_name)/g

/** 临时标签（如 {#player}）会残留进显示名，用于清理。 */
const TEMP_TAG_IN_NAME_RE = /\{#[^}]*\}/g

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

/** 清理名字里的临时标签（与 Python clean_name 对齐）。 */
export function cleanName(name: string): string {
  return (name ?? '').replace(TEMP_TAG_IN_NAME_RE, '').trim()
}

/**
 * 扫描反编译脚本中的 Character 定义，返回 {who 简写: 显示名}。
 * 跳过 tl/<lang> 译文目录（只吃原版脚本）。
 */
export function extractCharacters(gameDir: string): Map<string, string> {
  const gamedir = join(gameDir, 'game')
  const root = existsSync(gamedir) ? gamedir : gameDir
  const mapping = new Map<string, string>()
  for (const p of collectRpyFiles(root).sort()) {
    const rel = relative(root, p).split(sep).join('/')
    if (rel.split('/').includes('tl')) continue
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(CHAR_RE)) {
      const who = m[1]
      let name = m[2] ?? m[3] ?? ''
      if (m[0].includes('game_state.player_name')) name = '玩家'
      else if (!name && m[0].includes('None')) name = '旁白'
      name = cleanName(name)
      if (who && name) mapping.set(who, name)
    }
  }
  return mapping
}
