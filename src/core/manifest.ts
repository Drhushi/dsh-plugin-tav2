/**
 * 交付 manifest（src/core，不依赖 dsh）。
 *
 * 非侵入契约的声明式清单：补丁包内 tav2-manifest.json 登记每个交付文件的相对路径
 * 与 sha256，外加引擎/语言/来源版本指纹等元数据。删除清单所列路径即完全还原；
 * tav2_uninstall 按此清单精确删除，绝不越界。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const MANIFEST_FILENAME = 'tav2-manifest.json'

export interface ManifestFileEntry {
  /** 相对补丁包根的 POSIX 路径 */
  path: string
  /** 文件 sha256 */
  sha256: string
}

export interface Tav2Manifest {
  schemaVersion: 1
  createdAt: string
  engine: string
  lang: string
  locale: string
  displayVersion: string
  /** 来源游戏版本指纹（core/fingerprint 产出），缺省为空串 */
  fingerprint: string
  files: ManifestFileEntry[]
}

/** 生成 manifest 所需的元数据（引擎/语言/来源指纹）。 */
export interface ManifestMeta {
  engine: string
  lang: string
  locale: string
  displayVersion: string
  fingerprint: string
}

export function hashFile(path: string): string {
  const buf = readFileSync(path)
  return createHash('sha256').update(buf).digest('hex')
}

/** 递归收集补丁包内相对路径（POSIX，排序），排除 manifest 自身。 */
export function walkPatchFiles(patchDir: string): string[] {
  const out: string[] = []
  const stack = [{ dir: patchDir, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    let entries: { name: string; isDir: boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }))
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (relPath === MANIFEST_FILENAME) continue
      if (entry.isDir) stack.push({ dir: join(dir, entry.name), rel: relPath })
      else out.push(relPath)
    }
  }
  return out.sort()
}

/** 生成 manifest（不写盘）。 */
export function generateManifest(
  patchDir: string,
  meta: ManifestMeta,
  createdAt = new Date().toISOString(),
): Tav2Manifest {
  const files = walkPatchFiles(patchDir).map((path) => ({
    path,
    sha256: hashFile(join(patchDir, path)),
  }))
  return { schemaVersion: 1, createdAt, ...meta, files }
}

/** 把 manifest + 人类可读 README（含路径清单与契约说明）写入补丁包。 */
export function writeManifest(
  patchDir: string,
  meta: ManifestMeta,
  extraNote = '',
  runtimeRequirements: string[] = [],
): { manifestPath: string; readmePath: string } {
  const readmePath = join(patchDir, 'README.txt')
  // 先写占位 README 让清单能看到它；随后再写完整内容并重新生成清单（保证 README 被登记、sha256 正确）。
  writeFileSync(readmePath, 'tav2 补丁式交付物（占位）\n', 'utf8')
  const listed = generateManifest(patchDir, meta).files
  const readmeLines = [
    'tav2 补丁式交付物（非侵入契约）',
    '===============================',
    '',
    '本目录全部为「新增文件」，绝不覆盖/修改任何原游戏文件。',
    '把本目录内容合并进游戏根目录即生效；删除下列清单所列路径即可完全还原：',
    '机器可读清单见 tav2-manifest.json（tav2_uninstall 按此精确删除）。',
    '',
    ...listed.map((f) => `  - ${f.path}`),
    '',
    `来源版本指纹：${meta.fingerprint || '（未记录）'}（${meta.displayVersion}）`,
    '运行时前置条件（由用户自行安装，不属本补丁包）：CJK 字体（如 Noto Sans SC）等。',
    ...(runtimeRequirements.length > 0
      ? ['', '本游戏需要的运行时前置组件（用户自装，不属本补丁包）：', ...runtimeRequirements.map((n) => `  - ${n}`)]
      : []),
    '语言切换：Ren\'Py 设置→语言菜单选择对应语言。',
    extraNote ? `\n${extraNote}` : '',
  ].filter(Boolean)
  writeFileSync(readmePath, `${readmeLines.join('\n')}\n`, 'utf8')
  const manifest = generateManifest(patchDir, meta)
  const manifestPath = join(patchDir, MANIFEST_FILENAME)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifestPath, readmePath }
}

/** 读取补丁包 manifest；缺失/损坏返回 null。 */
export function readManifest(patchDir: string): Tav2Manifest | null {
  const path = join(patchDir, MANIFEST_FILENAME)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Tav2Manifest
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.files)) return null
    return raw
  } catch {
    return null
  }
}

/** 校验 rel 是否在 root 内；越界（绝对路径 / .. / 空）返回 null，否则返回绝对路径。 */
export function resolveWithin(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null
  const segs = rel.split(/[\\/]/).filter(Boolean)
  if (segs.length === 0 || segs.some((s) => s === '..')) return null
  const abs = resolve(root, ...segs)
  const rootResolved = resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null
  return abs
}

/** 把 manifest 的路径映射到目标根目录下的绝对路径（越界条目被丢弃）。 */
export function listManifestTargets(
  manifest: Tav2Manifest,
  targetRoot: string,
): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = []
  for (const f of manifest.files) {
    const abs = resolveWithin(targetRoot, f.path)
    if (abs) out.push({ rel: f.path, abs })
  }
  return out
}
