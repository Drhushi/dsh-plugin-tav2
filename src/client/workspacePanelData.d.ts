/**
 * src/client/workspacePanelData.js 的类型声明（纯 JS 实现，类型宽松，仅描述签名）。
 */
export function workspaceDirOf(
  sessionId: string,
  items: ReadonlyArray<{ path?: unknown; sessionIds?: unknown }> | null | undefined,
): string
export function panelStateOf(json: unknown): {
  kind: 'ok' | 'no-project' | 'not-initialized' | 'multiple-projects' | 'error'
  panel?: unknown
  message?: string
  candidates?: string[]
  project?: { name?: unknown; dir?: unknown; lang?: unknown }
  projects?: string[]
}
export function idsCsv(ids: unknown): string
export function projectSwitchCommand(dir: string): string
export function worldbookConfirmCommand(ids: unknown): string
export function worldbookDeleteCommand(ids: unknown): string
export function worldbookEditCommand(entry: unknown): string
export function deliberateApproveCommand(ids: unknown): string
export function deliberateRejectCommand(ids: unknown): string
export function worldbookAddCommand(entry: unknown): string
export type NextStepAction = { type: 'jump'; target: string } | { type: 'phrase'; phrase: string }
export function nextStepOf(panel: unknown): { key: string; title: string; action: NextStepAction } | null
export function activeRunOf(panel: unknown): Record<string, unknown> | null
export function formatTime(value: unknown): string
export function projectLabelOf(dir: unknown, allDirs: unknown): string
export function stageLabelOf(stage: unknown): string
export function formatDuration(totalSeconds: unknown): string
export function liveStatsOf(prompts: unknown): {
  calls: number
  tokens: number
  scenes: number
  errors: number
  last: Record<string, unknown> | null
}
export function runSummaryOf(summary: unknown): string
export function extensionSlotsOf(): string[]
export function sortWorldbookProposedFirst(list: unknown): Array<Record<string, unknown>>
export function sceneUnitsUrlOf(dir: unknown, sessionId: unknown, sceneId: unknown): string
export function unitStatusTone(status: unknown): 'ok' | 'danger' | 'muted' | null
export function unitStatusLabel(status: unknown): string
