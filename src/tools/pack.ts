/**
 * tav2_pack：把翻译结果打包成「补丁式」交付物。
 *
 * - Ren'Py：把 tl/<lang>（含字体补丁）打包为 <游戏名>/game/<游戏名>_tl_<lang>.rpa
 *   （RPA-3.0，内部路径 tl/<lang>/...），合并游戏同名文件夹即生效；
 *   Ren'Py 设置→语言菜单自动出现该语言（游戏内中英切换）。
 *
 * 输出基础目录默认 config.projectDir/patch/，可用 --out 覆盖；tav2_deploy 语义不变。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { computeGameFingerprint, readFingerprintSnapshot, storeFingerprintSnapshot, type GameFingerprint } from '../core/fingerprint'
import { writeManifest } from '../core/manifest'
import { loadEngineConfigFor, resolveProjectDbPath, resolveProjectDir, type EngineConfig } from '../engine/config'
import { tlRoot } from '../engine/adapters/renpy/tlparser'
import { FONT_EXTENSIONS } from '../engine/fonts/scan'
import { writeRpaArchive } from '../engine/adapters/renpy/rpa'
import { ProjectDB } from '../engine/db'
import { evaluateClosure } from '../engine/adapters/renpy/closure'
import { resolveSourceGameDirs, resolveSourceRoot } from '../engine/adapters/renpy/sourceDir'
import { resolveLang, sessionKeyOf } from './select_project'

export interface PackArgs {
  /** 要打包的目标语言（缺省=本会话目标语言）。 */
  lang?: string
  /** 输出基础目录（缺省=projectDir/patch）。 */
  out?: string
  /** 打包成功后删除反编译源码参考目录 <游戏根>/tav2_src（结项清场；默认保留）。 */
  clean_source?: boolean
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

/** 收尾对账的锁定术语来源（项目 DB terms 表 status=locked）。 */
function lockedTermsOf(config: Config, engineCfg: EngineConfig): Array<{ source: string; target: string }> {
  const db = new ProjectDB(resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir))
  try {
    return db.lockedTerms().map((t) => ({ source: String(t.source), target: String(t.target) }))
  } finally {
    db.close()
  }
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
  const warnings: string[] = []
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
    // 旧暂存链路（game_dir 指向 <游戏名>_prep）交付物仍按原游戏名命名；
    // 新链路 game_dir 即真实游戏根，basename 本来就是原游戏名。
    const gameName = (basename(engineCfg.gameDir) || 'game').replace(/_prep$/, '')
    const outputDir = join(outBase, gameName)
    mkdirSync(outputDir, { recursive: true })
    const fp = engineCfg.gameDir ? computeGameFingerprint(engineCfg.engine, engineCfg.gameDir) : null
    let closureNote = ''

    if (engineCfg.engine === 'renpy') {
      const srcTl = tlRoot(engineCfg.gameDir, lang)
      if (!existsSync(srcTl)) {
        return fail(`未找到 tl/${lang} 目录：${srcTl}（先用 tav2_prepare/translate 产出翻译）`)
      }
      // 收尾门禁（fail-closed）+ 角色名重定义补丁生成：
      // 绿门覆盖率是自指指标，裸角色显示名 / renpy.input 提示词这类模板外残留
      // 漏译不会被发现——打包前必须对账收口，杜绝「100% 覆盖 + 英文人名」假阳性。
      const closure = evaluateClosure({
        sourceGameDirs: resolveSourceGameDirs(engineCfg.gameDir).length > 0
          ? resolveSourceGameDirs(engineCfg.gameDir)
          : [engineCfg.gameDir],
        tlDir: srcTl,
        lang,
        lockedTerms: lockedTermsOf(config, engineCfg),
      })
      if (closure.audited && !closure.ok) {
        return fail(
          `收尾对账未通过（模板外残留 ${closure.issues.length} 处），已拒绝打包：\n`
          + closure.issues.map((i) => `- ${i.detail}`).join('\n')
          + '\n请先 tav2_check 查看明细：锁定人名术语（tav2_deliberate_confirm）或补齐提示词后再打包。',
        )
      }
      if (closure.characterNamePatch) {
        // 先写盘再收集文件，补丁随 collectTlFiles 自动进 rpa 与 manifest
        writeFileSync(join(srcTl, 'zzz_character_names.rpy'), closure.characterNamePatch, 'utf8')
        closureNote = `已生成角色名重定义补丁：tl/${lang}/zzz_character_names.rpy（${closure.characterNames.patchable} 名，translate python 块）。\n`
      }
      const rpaFiles = collectTlFiles(srcTl, lang)
      if (rpaFiles.size === 0) {
        return fail(`tl/${lang} 目录为空：${srcTl}`)
      }
      // G5 前置：config 声明了默认字体但 tl/<lang>/font 里没有字体文件，
      // 打出的补丁装上后 CJK 大概率方框（verify 会拦，但 pack 时就提示免一次重打包）。
      const fontDefault = engineCfg.fonts?.default?.trim() ?? ''
      if (fontDefault) {
        const fontDir = join(srcTl, 'font')
        const hasFontFile = existsSync(fontDir) && readdirSync(fontDir)
          .some((f) => FONT_EXTENSIONS.includes(extname(f).toLowerCase()))
        if (!hasFontFile) {
          warnings.push(
            `⚠️ config fonts.default=${fontDefault} 但 tl/${lang}/font/ 下没有字体文件（打包会缺字体，实机可能出现方框）；`
            + '先 tav2_font pick 落地字体再打包。',
          )
        }
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
      // 结项清场：仅删除约定命名的源码参考目录（<游戏根>/tav2_src，含 game/ 校验），
      // 不碰松散 tl（它是事实源，重新封包/改动都从它出发）。
      let cleanedNote = ''
      if (args.clean_source) {
        const sourceRoot = resolveSourceRoot(engineCfg.gameDir)
        if (sourceRoot && basename(sourceRoot) === 'tav2_src' && existsSync(join(sourceRoot, 'game'))) {
          rmSync(sourceRoot, { recursive: true, force: true })
          cleanedNote = `已清理源码参考目录：${sourceRoot}\n`
        }
      }
      return {
        ok: true,
        command: `pack lang=${lang}`,
        text: (warnings.length ? `${warnings.join('\n')}\n` : '')
          + `已生成 Ren'Py 补丁：${outRpa}\n`
          + `把 ${outputDir}/game 合并进游戏根目录即可生效；Ren'Py 设置→语言菜单会出现 ${lang}（配合字体补丁可正常显示）。\n`
          + `松散译文 ${srcTl} 仍是事实源：改动后重跑 tav2_pack 即可重新导出。`
          + closureNote
          + cleanedNote,
        timedOut: false,
        outputDir,
        files,
      }
    }

    return fail(`暂不支持引擎 ${engineCfg.engine} 的补丁打包（当前适配器仅实现 renpy）`)
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
      clean_source: {
        type: 'boolean',
        description: '打包成功后删除反编译源码参考目录 <游戏根>/tav2_src（结项清场；默认保留）',
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
