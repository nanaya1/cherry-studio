/**
 * Strict structured-action protocol for the independent industrial-video engine.
 *
 * The model is instructed to emit ONLY a single JSON object on every step, which is exactly one of:
 *   - a final reply:    `{ "reply": "<non-empty text>" }`
 *   - a single action:  `{ "action": { "tool": "<white-listed tool>", "args": { ... } } }`
 *
 * Anything else is rejected so the engine never runs an action it did not parse, never infers a
 * tool call from free text, and never executes more than one tool per step. This is the gate that
 * keeps the model from "signing off" on work or calling tools outside the trusted contract.
 */

export type StructuredAction =
  | { kind: 'reply'; text: string }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }

export type ParseStructuredActionResult = { ok: true; action: StructuredAction } | { ok: false; reason: string }

const TOP_KEYS = ['reply', 'action'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a model emission into a single structured action. `allowedTools` is the trusted white-list
 * of industrial tools (e.g. `INDUSTRIAL_VIDEO_TOOLS`); any other tool name is rejected so the
 * engine never executes an untrusted action. Per-step argument structure is validated shallowly
 * here; deeper argument validation belongs to the trusted tool executor.
 */
export function parseStructuredAction(input: unknown, allowedTools: ReadonlySet<string>): ParseStructuredActionResult {
  let value: unknown = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return { ok: false, reason: 'empty' }
    try {
      value = JSON.parse(trimmed)
    } catch {
      // Free narration: the model emitted prose instead of the strict JSON contract.
      return { ok: false, reason: 'not_json' }
    }
  }

  if (!isPlainObject(value)) return { ok: false, reason: 'not_object' }
  const keys = Object.keys(value)
  if (keys.length !== 1) return { ok: false, reason: 'multiple_fields' }
  const key = keys[0]
  if (!TOP_KEYS.includes(key as (typeof TOP_KEYS)[number])) {
    return { ok: false, reason: 'unknown_field' }
  }

  if (key === 'reply') {
    const text = typeof value.reply === 'string' ? value.reply.trim() : ''
    if (!text) return { ok: false, reason: 'empty_reply' }
    return { ok: true, action: { kind: 'reply', text } }
  }

  // key === 'action'
  const action = value.action
  if (!isPlainObject(action)) return { ok: false, reason: 'action_not_object' }
  const actionKeys = Object.keys(action).sort()
  if (actionKeys.length !== 2 || actionKeys[0] !== 'args' || actionKeys[1] !== 'tool') {
    return { ok: false, reason: 'action_bad_fields' }
  }
  if (typeof action.tool !== 'string' || !allowedTools.has(action.tool)) {
    return { ok: false, reason: 'unknown_tool' }
  }
  if (!isPlainObject(action.args)) return { ok: false, reason: 'args_not_object' }
  return { ok: true, action: { kind: 'tool', tool: action.tool, args: action.args } }
}
