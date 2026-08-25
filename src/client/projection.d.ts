/**
 * src/client/projection.js 的类型声明（纯 JS 实现，类型宽松，仅描述签名）。
 */
export function lastToolMeta(
  nodes: readonly unknown[] | null | undefined,
  toolName: string,
): unknown
export function parseJobDetail(
  text: string | null | undefined,
): Record<string, { done: number; total: number } | number>
export function isTav2Job(label: unknown): boolean
export function isTranslatorTrace(nodes: readonly unknown[] | null | undefined): boolean
