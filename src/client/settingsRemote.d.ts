/**
 * src/client/settingsRemote.js 的类型声明（纯 JS 实现，类型宽松，仅描述签名）。
 */

export type RemoteError = { code: string; message: string }
export type RemoteEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: RemoteError }
/** 归一后的结果：ok=false 时带 error，ok=true 时带 value（宽松形状，便于调用方直接取字段）。 */
export type RemoteOutcome<T = unknown> = { ok: boolean; value?: T; error?: RemoteError }
export type ChannelDraft = { name: string; baseUrl: string; model: string; scope: string }

export declare const SCOPE_VALUES: string[]
export declare const SETTINGS_UNAVAILABLE_MESSAGE: string
export declare const CREDENTIALS_UNAVAILABLE_MESSAGE: string
export declare const NAMESPACE_MISSING_MESSAGE: string

export function remoteFacesOf(ctx: unknown): {
  settings?: unknown
  credentials?: unknown
  missing: string[]
}
export function unwrapRemote(response: unknown): RemoteOutcome
export function readSettingsDescribe(settings: unknown): Promise<{
  ok: boolean
  value?: { writable?: unknown; namespaces?: unknown[] }
  error?: RemoteError
}>
export function namespaceRowOf(describeValue: unknown, ns: string): Record<string, any> | undefined
export function cardFatalMessage(
  faces: { settings?: unknown; credentials?: unknown; missing?: string[] } | null | undefined,
  described: { ok: boolean; value?: unknown; error?: RemoteError } | null | undefined,
  nsRow: unknown,
): string | null
export function cardModelOf(row: unknown): {
  channels: ChannelDraft[]
  active: string
  renpySdk: string
  revision?: number
}
export function channelRefOf(name: string): string
export function channelProblem(channel: { name?: unknown; baseUrl?: unknown } | null | undefined, existingNames?: string[]): string | null
export function invalidChannelRows(channels: unknown): number[]
export function readCredentialStates(credentials: unknown, refs: unknown): Promise<{
  ok: boolean
  states: Record<string, boolean>
  error?: RemoteError
}>
export function writeCardSettings(
  settings: unknown,
  ns: string,
  patch: Record<string, unknown>,
  revision: number | undefined,
): Promise<{ ok: boolean; conflict: boolean; value?: unknown; error?: RemoteError }>
export function writeCredentialDrafts(
  credentials: unknown,
  drafts: Array<{ ref: string; value: string }>,
): Promise<{ ok: boolean; failures: Array<{ ref: string; message: string }> }>
