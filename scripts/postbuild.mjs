/**
 * 构建后处理：给 dist 内相对导入补 .js 扩展名（纯 Node ESM 可加载）。
 * 源码无扩展名导入是给 tsx/vitest 用的；dist 需要显式扩展名。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const RELATIVE_IMPORT = /(from\s*['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"]\s*\)?)/g

function patch(text, file) {
  const base = dirname(file)
  return text.replace(RELATIVE_IMPORT, (_whole, prefix, spec, suffix) => {
    if (/\.(?:js|mjs|cjs|json)$/.test(spec)) return _whole
    const target = resolve(base, spec)
    if (existsSync(target) && statSync(target).isDirectory()) {
      // 目录导入（包内目录）：ESM 需显式 index.js
      return `${prefix}${spec}/index.js${suffix}`
    }
    return `${prefix}${spec}.js${suffix}`
  })
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...walk(path))
    } else if (path.endsWith('.js') || path.endsWith('.mjs')) {
      out.push(path)
    }
  }
  return out
}

let changed = 0
for (const file of walk(ROOT)) {
  const original = readFileSync(file, 'utf8')
  const next = patch(original, file)
  if (next !== original) {
    writeFileSync(file, next, 'utf8')
    changed += 1
  }
}
console.log(`[postbuild] 补扩展名：${changed} 个文件`)
