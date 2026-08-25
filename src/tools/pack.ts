/**
 * tav2_pack：把翻译结果打包成「补丁式」交付物。
 *
 * - Ren'Py：把 tl/<lang>（含字体补丁）打包为 <游戏名>/game/<游戏名>_tl_<lang>.rpa
 *   （RPA-3.0，内部路径 tl/<lang>/...），合并游戏同名文件夹即生效；
 *   Ren'Py 设置→语言菜单自动出现该语言（游戏内中英切换）。
 *
 * 输出基础目录默认 config.projectDir/patch/，可用 --out 覆盖；tav2_deploy 语义不变。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { computeGameFingerprint, readFingerprintSnapshot, storeFingerprintSnapshot, type GameFingerprint } from '../core/fingerprint'
import { writeManifest } from '../core/manifest'
import { loadEngineConfigFor, resolveProjectDbPath, resolveProjectDir, type EngineConfig } from '../engine/config'
import { tlRoot } from '../engine/adapters/renpy/tlparser'
import { writeRpaArchive } from '../engine/adapters/renpy/rpa'
import { ProjectDB } from '../engine/db'
import { resolveLang, sessionKeyOf } from './select_project'

export interface PackArgs {
  /** 要打包的目标语言（缺省=本会话目标语言）。 */
  lang?: string
  /** 输出基础目录（缺省=projectDir/patch）。 */
  out?: string
}

export interface Tav2PackResult extends Tav2ToolResult {
  outputDir: string
  files: string[]
}

/** 递归收集 tl/<lang> 下文件，内部路径 tl/<lang>/<rel>（排序保证确定性）。 */
function collectTlFiles(srcTl: string, lang: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (cur: string, rel: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const full = join(cur, name)
      const childRel = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) walk(full, childRel)
      else files.set(`tl/${lang}/${childRel}`, readFileSync(full))
    }
  }
  walk(srcTl, '')
  return files
}

/** 打包时把版本指纹快照写入项目 DB 与 work 目录（失败不阻断打包，manifest 已内嵌指纹）。 */
function ensureFingerprintSnapshot(
  config: Config,
  engineCfg: EngineConfig,
  fp: GameFingerprint,
): void {
  try {
    const projectDir = resolveProjectDir(engineCfg, config.engineConfigPath, config.projectDir)
    const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
    try {
      const snap = readFingerprintSnapshot(db)
      if (!snap || snap.fingerprint !== fp.fingerprint) storeFingerprintSnapshot(db, projectDir, fp)
    } finally {
      db.close()
    }
  } catch {
    // 快照写入失败不阻断打包（manifest 已内嵌指纹）
  }
}

/** 执行补丁打包（工具 execute 与测试共用）。 */
export async function runTsPack(
  config: Config,
  args: PackArgs,
  sessionKey?: string,
  timeoutMs = config.timeoutMs,
): Promise<Tav2PackResult> {
  const lang = (args.lang ?? '').trim() || resolveLang(config, sessionKey)
  const outBase = (args.out ?? '').trim() || join(config.projectDir || process.cwd(), 'patch')
  const files: string[] = []
  const fail = (text: string): Tav2PackResult => ({
    ok: false,
    command: `pack lang=${lang}`,
    text,
    timedOut: false,
    outputDir: '',
    files: [],
  })
  try {
    const engineCfg = loadEngineConfigFor(config)
    const gameName = basename(engineCfg.gameDir) || 'game'
    const outputDir = join(outBase, gameName)
    mkdirSync(outputDir, { recursive: true })
    const fp = engineCfg.gameDir ? computeGameFingerprint(engineCfg.engine, engineCfg.gameDir) : null

    if (engineCfg.engine === 'renpy') {
      const srcTl = tlRoot(engineCfg.gameDir, lang)
      if (!existsSync(srcTl)) {
        return fail(`未找到 tl/${lang} 目录：${srcTl}（先用 tav2_prepare/translate 产出翻译）`)
      }
      const rpaFiles = collectTlFiles(srcTl, lang)
      if (rpaFiles.size === 0) {
        return fail(`tl/${lang} 目录为空：${srcTl}`)
      }
      const outRpa = join(outputDir, 'game', `${gameName}_tl_${lang}.rpa`)
      mkdirSync(dirname(outRpa), { recursive: true })
      writeFileSync(outRpa, writeRpaArchive(rpaFiles)) // TS 原生打包，不再依赖 python 子进程
      files.push(outRpa)
      if (fp) {
        const { manifestPath, readmePath } = writeManifest(outputDir, {
          engine: engineCfg.engine,
          lang,
          locale: lang,
          displayVersion: fp.displayVersion,
          fingerprint: fp.fingerprint,
        }, '', engineCfg.runtime.requirements.map((r) => r.name))
        files.push(manifestPath, readmePath)
        ensureFingerprintSnapshot(config, engineCfg, fp)
      }
      return {
        ok: true,
        command: `pack lang=${lang}`,
        text: `已生成 Ren'Py 补丁：${outRpa}\n`
          + `把 ${outputDir}/game 合并进游戏根目录即可生效；Ren'Py 设置→语言菜单会出现 ${lang}（配合字体补丁可正常显示）。`,
        timedOut: false,
        outputDir,
        files,
      }
    }

    return fail(`暂不支持引擎 ${engineCfg.engine} 的补丁打包（当前仅支持 renpy）`)
  } catch (err) {
    return fail(`补丁打包失败：${String(err instanceof Error ? err.message : err)}`)
  }
}

export function registerPackTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'tav2_pack',
    description: '把翻译结果打包成补丁式交付物：Ren\'Py 产出 <游戏名>/game/<游戏名>_tl_<lang>.rpa；'
      + '把 <游戏名> 目录合并进游戏根目录即用，不修改原游戏文件。',
    parameters: {
      lang: {
        type: 'string',
        description: '要打包的目标语言（缺省=本会话目标语言，/tav2-lang 设置）',
      },
      out: {
        type: 'string',
        description: '输出基础目录（缺省=projectDir/patch）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          text: { type: 'string' },
          timedOut: { type: 'boolean' },
          outputDir: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_args, value: Tav2PackResult) => [{
        type: 'text',
        text: value.ok ? value.text : `打包失败：${value.text}`,
      }],
    },
    async execute(args: PackArgs, exec) {
      return runTsPack(config, args, sessionKeyOf(exec))
    },
  }))
}
