import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { registerCheckTool } from './check'
import { registerComplianceTool } from './compliance'
import { registerDeliberateTool } from './deliberate'
import { registerDeliberateConfirmTool } from './deliberate_confirm'
import { registerDeployTool } from './deploy'
import { registerDiffTool } from './diff'
import { registerFingerprintTool } from './fingerprint'
import { registerUninstallTool } from './uninstall'
import { registerDetectTool } from './detect'
import { registerInitTool } from './init'
import { registerPrepareTool } from './prepare'
import { registerReportTool } from './report'
import { registerReviewBackfillTool } from './review_backfill'
import { registerSelectProjectTool } from './select_project'
import { registerStatusTool } from './status'
import { registerTermsTool } from './terms'
import { registerTranslateBatchTool } from './translate_batch'
import { registerVerifyTool } from './verify'
import { registerWorldbookTool } from './worldbook'
import { registerWorldbookEditTool } from './worldbook_edit'
import { registerPackTool } from './pack'
import { registerMigrateTool } from './migrate'
import { registerFontTool } from './font'

/** 轻量引导工具集：普通工作区（未识别为游戏）也会安装，供 agent 引导「初始化游戏翻译」。 */
export const SLIM_TOOL_NAMES = ['tav2_detect', 'tav2_init', 'tav2_select_project', 'tav2_status']

const TOOL_REGISTRY: Record<string, (ctx: Context, config: Config) => void> = {
  tav2_detect: registerDetectTool,
  tav2_init: registerInitTool,
  tav2_status: registerStatusTool,
  tav2_compliance: registerComplianceTool,
  tav2_prepare: registerPrepareTool,
  tav2_worldbook: registerWorldbookTool,
  tav2_worldbook_edit: registerWorldbookEditTool,
  tav2_terms: registerTermsTool,
  tav2_deliberate: registerDeliberateTool,
  tav2_deliberate_confirm: registerDeliberateConfirmTool,
  tav2_translate_batch: registerTranslateBatchTool,
  tav2_review_backfill: registerReviewBackfillTool,
  tav2_report: registerReportTool,
  tav2_check: registerCheckTool,
  tav2_verify: registerVerifyTool,
  tav2_deploy: registerDeployTool,
  tav2_select_project: registerSelectProjectTool,
  tav2_diff: registerDiffTool,
  tav2_fingerprint: registerFingerprintTool,
  tav2_uninstall: registerUninstallTool,
  tav2_pack: registerPackTool,
  tav2_migrate: registerMigrateTool,
  tav2_font: registerFontTool,
}

/** 全套工具名（含轻量集；tav2_init 是引导与全套共用的初始化工具）。 */
export const ALL_TOOL_NAMES = Object.keys(TOOL_REGISTRY)

/**
 * 按名单注册工具；缺省注册全套。返回本次请求注册的名字（实际由调用方按增量过滤）。
 * 同名工具重复注册会抛错，升级/幂等场景请先用 scope_track.missingToolNames 取增量。
 */
export function registerTools(ctx: Context, config: Config, include?: string[]): string[] {
  const names = include ?? ALL_TOOL_NAMES
  for (const name of names) {
    const register = TOOL_REGISTRY[name]
    if (register) register(ctx, config)
  }
  return names
}
