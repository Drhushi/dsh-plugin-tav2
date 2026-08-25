/**
 * TS 知识层工具后端：engineBackend=ts 时直接跑 TS 引擎。
 * Ren'Py 文档由 src/engine/adapters/renpy 产出（M5 已落地）；
 * engineBackend=python 时仍走临时 Python 桥用于 A/B 对照。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import type { Tav2ToolResult } from '../core/types'
import { documentFromPython } from '../engine/bridge'
import { loadEngineConfigFor, resolveProjectDbPath, type EngineConfig } from '../engine/config'
import { ProjectDB } from '../engine/db'
import { resolveTranslationGenerate } from './translationApi'
import { renpyAdapter } from '../engine/adapters'
import { scanLinesRenpy } from '../engine/adapters/renpy/adapter'
import type { Generate } from '../engine/llm'
import type { Document } from '../engine/models'

export interface KnowledgeInput {
  engineCfg: EngineConfig
  dbPath: string
  document: Document
  scanLines: string[]
}

export interface KnowledgeContext extends KnowledgeInput {
  db: ProjectDB
}

/** 加载引擎配置与文档（不打开 DB）。 */
export function loadKnowledgeInput(config: Config): KnowledgeInput {
  const engineCfg = loadEngineConfigFor(config)
  if (config.engineBackend === 'ts') {
    if (!engineCfg.gameDir) {
      throw new Error('TS 后端需要 config.yaml 中配置 game_dir')
    }
    let document: Document
    let scanLines: string[]
    if (engineCfg.engine === 'renpy') {
      const extracted = renpyAdapter.extract(engineCfg.gameDir, {
        lang: engineCfg.lang,
        branchDetect: engineCfg.branch.detect,
      })
      document = extracted.document
      scanLines = scanLinesRenpy(engineCfg.gameDir, engineCfg.lang)
    } else {
      throw new Error(`TS 后端当前只支持 renpy 引擎，收到：${engineCfg.engine}`)
    }
    // 引擎无关兜底：适配器未提供基于文件的原文行时，
    // 从文档单元合成原文行，保证 worldbook/terms 等 scanLines 消费者有输入。
    if (scanLines.length === 0) scanLines = scanLinesFromDocument(document)
    return {
      engineCfg,
      dbPath: resolveProjectDbPath(engineCfg, config.engineConfigPath, config.projectDir),
      document,
      scanLines,
    }
  }

  const bridge = documentFromPython(config)
  return { engineCfg, dbPath: bridge.dbPath, document: bridge.document, scanLines: bridge.scanLines }
}

/** 从文档单元合成原文行（引擎无关）：[伪文件:行号] 原文，供 scanLines 消费者使用。 */
export function scanLinesFromDocument(document: Document): string[] {
  const out: string[] = []
  for (const scene of document.scenes) {
    const pseudo = scene.scene_id.replace(/:/g, '_')
    scene.units.forEach((unit, i) => {
      out.push(`[${pseudo}:${i}] ${unit.source}`)
    })
  }
  return out
}

/** 打开 TS 知识层所需的引擎配置 / 文档 / 项目 DB。调用方负责 db.close()。 */
export function openKnowledge(config: Config): KnowledgeContext {
  const input = loadKnowledgeInput(config)
  const db = new ProjectDB(input.dbPath)
  // 把当前提取的单元同步进项目 DB（syncUnits 幂等、不覆盖已译状态），
  // 让 status/extract 等读路径也补齐 DB，避免“status 有单元、DB 却为空”的割裂。
  db.syncUnits(input.document)
  return { ...input, db }
}

/** 创建走 dsh ctx.llm 的引擎 Generate。 */
/** 创建当前生效翻译通道的引擎 Generate（专用 API 或宿主 ctx.llm，按 scope 决定）。 */
export async function tsGenerate(ctx: Context, config: Config, engineCfg: EngineConfig): Promise<Generate> {
  return resolveTranslationGenerate(ctx, config, engineCfg, 'knowledge')
}

/** 统计 scan_lines 前缀 [文件:行号] 中的不同文件数。 */
export function sourceFileCount(lines: string[]): number {
  const names = new Set<string>()
  for (const line of lines) {
    const m = /^\[([^:\]]+):/.exec(line)
    if (m) names.add(m[1]!)
  }
  return names.size
}

/** 构造 TS 后端的工具返回值。 */
export function tsKnowledgeResult(text: string, ok = true): Tav2ToolResult {
  return { ok, command: 'engineBackend=ts', text, timedOut: false }
}
