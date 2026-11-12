import * as z from 'zod'

/**
 * Trusted industrial-video execution mode, bound once at session creation and read back by the
 * host runtime to decide which connection adapter serves the session. It is stored in the
 * main-owned production record (never renderer-controlled), so an ordinary agent/session patch
 * cannot change it after creation.
 *
 * - `native`: the existing Claude Code runtime path (unchanged).
 * - `structured-action`: the independent structured-action engine — the model emits strict JSON
 *   single actions / final replies, executed through the trusted tool contract.
 */
// export type IndustrialVideoExecutionMode = 'native' | 'structured-action'
export type IndustrialVideoExecutionMode = 'native' | 'structured-action' | 'dedicated-flow'

export const INDUSTRIAL_VIDEO_EXECUTION_MODES: readonly IndustrialVideoExecutionMode[] = [
  'native',
  'structured-action',
  'dedicated-flow'
] as const

/** 仅工业专用连接分流，不改变native或缺省旧会话。 */
export function usesIndustrialVideoDedicatedConnection(mode: IndustrialVideoExecutionMode): boolean {
  return mode === 'structured-action' || mode === 'dedicated-flow'
}

export const IndustrialVideoExecutionModeSchema = z.enum(INDUSTRIAL_VIDEO_EXECUTION_MODES).catch('native')

/** The default mode used when a session's record carries no explicit binding. */
export const DEFAULT_INDUSTRIAL_VIDEO_EXECUTION_MODE: IndustrialVideoExecutionMode = 'native'

export function isIndustrialVideoExecutionMode(value: unknown): value is IndustrialVideoExecutionMode {
  return typeof value === 'string' && (INDUSTRIAL_VIDEO_EXECUTION_MODES as readonly string[]).includes(value)
}
