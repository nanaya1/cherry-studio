import { describe, expect, it } from 'vitest'

import { parseStructuredAction } from './structuredActionProtocol'

const ALLOWED = new Set(['ivideo_parse', 'ivideo_start'])

describe('structured action protocol', () => {
  it('accepts a final reply object', () => {
    expect(parseStructuredAction({ reply: '成片已生成，请查看预览。' }, ALLOWED)).toEqual({
      ok: true,
      action: { kind: 'reply', text: '成片已生成，请查看预览。' }
    })
  })

  it('accepts a single white-listed action', () => {
    expect(parseStructuredAction({ action: { tool: 'ivideo_parse', args: { run: 'r1' } } }, ALLOWED)).toEqual({
      ok: true,
      action: { kind: 'tool', tool: 'ivideo_parse', args: { run: 'r1' } }
    })
  })

  it('parses strict JSON from a raw string', () => {
    const out = parseStructuredAction('{"action":{"tool":"ivideo_start","args":{}}}', ALLOWED)
    expect(out).toEqual({ ok: true, action: { kind: 'tool', tool: 'ivideo_start', args: {} } })
  })

  it.each([
    ['unknown tool', { action: { tool: 'shell_exec', args: {} } }],
    ['unknown field', { foo: 1 }],
    ['multiple fields', { reply: 'x', action: { tool: 'ivideo_parse', args: {} } }],
    ['action missing args', { action: { tool: 'ivideo_parse' } }],
    ['action extra field', { action: { tool: 'ivideo_parse', args: {}, extra: 1 } }],
    ['reply not a string', { reply: 5 }],
    ['empty reply', { reply: '   ' }],
    ['args not an object', { action: { tool: 'ivideo_parse', args: [1, 2] } }],
    ['action not an object', { action: 'ivideo_parse' }]
  ])('rejects %s', (_label, input) => {
    expect(parseStructuredAction(input, ALLOWED).ok).toBe(false)
  })

  it('rejects free narration and non-JSON text', () => {
    expect(parseStructuredAction('请先解析这段脚本再生成视频。', ALLOWED).ok).toBe(false)
    expect(parseStructuredAction('not json at all', ALLOWED).ok).toBe(false)
    expect(parseStructuredAction('', ALLOWED).ok).toBe(false)
  })

  it('拒绝缺少最外层闭合括号的动作，不自动修补或执行', () => {
    const incomplete = '{"action":{"tool":"ivideo_parse","args":{"run":"r1","storyboard":{"scenes":[]}}}'
    expect(parseStructuredAction(incomplete, ALLOWED)).toEqual({ ok: false, reason: 'not_json' })
  })

  it('rejects arrays and primitives', () => {
    expect(parseStructuredAction([{ reply: 'x' }], ALLOWED).ok).toBe(false)
    expect(parseStructuredAction(42, ALLOWED).ok).toBe(false)
    expect(parseStructuredAction(null, ALLOWED).ok).toBe(false)
  })
})
