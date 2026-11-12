import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRuntimeEvent, AgentRuntimeUserInput } from '@main/ai/runtime/types'
import { mockMainLoggerService } from '@test-mocks/MainLoggerService'

import {
  type IndustrialVideoStructuredConnectionDeps,
  type IndustrialVideoStructuredModel,
  type IndustrialVideoStructuredToolExecutor,
  IndustrialVideoStructuredConnection
} from './industrialVideoStructuredConnection'

const ALLOWED = new Set(['ivideo_parse', 'ivideo_start'])
const TOKEN = Object.freeze({ sessionId: 'sess-1', epoch: 3 })
const SYSTEM = 'emit strict JSON only'

function userInput(text: string): AgentRuntimeUserInput {
  return {
    message: {
      data: { parts: [{ type: 'text', text }] }
    } as unknown as AgentRuntimeUserInput['message']
  }
}

function baseDeps(
  overrides: Partial<IndustrialVideoStructuredConnectionDeps> = {}
): IndustrialVideoStructuredConnectionDeps {
  return {
    sessionId: 'sess-1',
    executionToken: TOKEN,
    model: { generateText: async () => ({ text: '{}' }) },
    toolExecutor: { execute: async () => ({ ok: true, result: 'done' }) },
    allowedTools: ALLOWED,
    systemPrompt: SYSTEM,
    stepCap: 8,
    extractUserText: (input) =>
      (input.message.data.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n'),
    ...overrides
  }
}

async function collectUntilComplete(conn: IndustrialVideoStructuredConnection): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = []
  for await (const event of conn.events) {
    events.push(event)
    if (event.type === 'turn-complete' || event.type === 'error') break
  }
  return events
}

describe('industrial video structured connection', () => {
  beforeEach(() => {
    mockMainLoggerService.warn.mockClear()
  })

  it('ends the turn on a final reply', async () => {
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({
        model: { generateText: async () => ({ text: JSON.stringify({ reply: '成片已生成。' }) }) }
      })
    )
    conn.send(userInput('生成视频'))
    const events = await collectUntilComplete(conn)
    expect(
      events.some((e) => e.type === 'chunk' && e.chunk.type === 'text-delta' && e.chunk.delta === '成片已生成。')
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
  })

  it('feeds the tool result into the next step', async () => {
    const model: IndustrialVideoStructuredModel = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({ text: JSON.stringify({ action: { tool: 'ivideo_parse', args: { run: 'r1' } } }) })
        .mockResolvedValueOnce({ text: JSON.stringify({ reply: '已解析。' }) })
    }
    const execute = vi.fn<IndustrialVideoStructuredToolExecutor['execute']>(async () => ({
      ok: true,
      result: { jobId: 'j1' }
    }))
    const conn = new IndustrialVideoStructuredConnection(baseDeps({ model, toolExecutor: { execute } }))
    conn.send(userInput('解析这段'))
    const events = await collectUntilComplete(conn)
    expect(execute).toHaveBeenCalledWith('ivideo_parse', { run: 'r1' }, TOKEN, expect.any(AbortSignal))
    expect(model.generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transcript: expect.arrayContaining([expect.objectContaining({ role: 'tool', content: '{"jobId":"j1"}' })])
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
  })

  it('does not fake success on a tool failure', async () => {
    const model: IndustrialVideoStructuredModel = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({ text: JSON.stringify({ action: { tool: 'ivideo_start', args: {} } }) })
    }
    const execute = vi.fn<IndustrialVideoStructuredToolExecutor['execute']>(async () => ({
      ok: false,
      error: 'invalid_settings'
    }))
    const conn = new IndustrialVideoStructuredConnection(baseDeps({ model, toolExecutor: { execute } }))
    conn.send(userInput('开始'))
    const events = await collectUntilComplete(conn)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(events.filter((e) => e.type === 'chunk').map((e) => e.chunk.type)).toEqual([
      'tool-input-available',
      'tool-output-error'
    ])
  })

  it('does not fake success on a model failure', async () => {
    const model: IndustrialVideoStructuredModel = {
      generateText: async () => {
        throw new Error('upstream')
      }
    }
    const conn = new IndustrialVideoStructuredConnection(baseDeps({ model }))
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })

  it.each([
    ['敏感原始回复', 'not_json'],
    ['{"action":{"tool":"unknown-sensitive-tool","args":{}}}', 'unknown_tool']
  ])('连续非法只请求两次，不执行且仅报告安全 reason：%s', async (text, reason) => {
    const generateText = vi.fn(async () => ({ text }))
    const execute = vi.fn()
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute }, stepCap: 16 })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: new Error(`结构化输出纠正失败（reason: ${reason}），已用完 1 次纠正，停止执行。`)
    })
    expect(JSON.stringify(generateText.mock.calls)).not.toContain(text)
    expect(generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transcript: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining(reason) })])
      })
    )
  })

  it('缺外层括号时要求完整重输出，不回显原文、不自动修补或增加纠正次数', async () => {
    const text = '{"action":{"tool":"ivideo_parse","args":{"run":"private-run"}}'
    const generateText = vi.fn<IndustrialVideoStructuredModel['generateText']>(async () => ({ text }))
    const execute = vi.fn()
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute } })
    )
    conn.send(userInput('解析'))
    const events = await collectUntilComplete(conn)
    const correction = generateText.mock.calls[1][0].transcript.find((entry) => entry.role === 'system')
    expect(correction?.content).toContain('重新输出完整对象')
    expect(correction?.content).toContain('action、args 及外层对象全部闭合')
    expect(correction?.content).toContain('不要只输出补丁或缺失字符')
    expect(JSON.stringify(generateText.mock.calls)).not.toContain('private-run')
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: new Error('结构化输出纠正失败（reason: not_json），已用完 1 次纠正，停止执行。')
    })
  })

  it('纠正不占合法步骤预算，合法动作仍受原有上限约束', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: 'invalid' })
      .mockResolvedValue({ text: '{"action":{"tool":"ivideo_start","args":{}}}' })
    const execute = vi.fn(async () => ({ ok: true as const, result: 'done' }))
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute }, stepCap: 3 })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(generateText).toHaveBeenCalledTimes(4)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ message: expect.stringContaining('step cap') })
    })
  })

  it('纠正为标准动作后正常执行并完成答复', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: 'invalid' })
      .mockResolvedValueOnce({ text: '{"action":{"tool":"ivideo_start","args":{}}}' })
      .mockResolvedValueOnce({ text: '{"reply":"已完成"}' })
    const execute = vi.fn(async () => ({ ok: true as const, result: 'done' }))
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute }, stepCap: 2 })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(generateText).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toEqual({ type: 'turn-complete' })
  })

  it('成功纠正后本轮不再追加纠正机会', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: 'invalid' })
      .mockResolvedValueOnce({ text: '{"action":{"tool":"ivideo_start","args":{}}}' })
      .mockResolvedValue({ text: 'invalid again' })
    const execute = vi.fn(async () => ({ ok: true as const, result: 'done' }))
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute } })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(generateText).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })

  it('does not start a tool when closed during generation (late response)', async () => {
    let resolveModel: (v: { text: string }) => void = () => undefined
    const model: IndustrialVideoStructuredModel = {
      generateText: () =>
        new Promise((res) => {
          resolveModel = res
        })
    }
    const execute = vi.fn<IndustrialVideoStructuredToolExecutor['execute']>(async () => ({ ok: true, result: 'done' }))
    const conn = new IndustrialVideoStructuredConnection(baseDeps({ model, toolExecutor: { execute } }))
    conn.send(userInput('开始'))
    // Let the generation begin, then close before it resolves.
    await Promise.resolve()
    conn.close()
    resolveModel({ text: JSON.stringify({ action: { tool: 'ivideo_start', args: {} } }) })
    const events = await collectUntilComplete(conn)
    expect(events).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects multiple actions in one output and corrects', async () => {
    const model: IndustrialVideoStructuredModel = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify([
            { action: { tool: 'ivideo_parse', args: {} } },
            { action: { tool: 'ivideo_start', args: {} } }
          ])
        })
        .mockResolvedValueOnce({ text: JSON.stringify({ reply: '已修正。' }) })
    }
    const execute = vi.fn()
    const conn = new IndustrialVideoStructuredConnection(baseDeps({ model, toolExecutor: { execute } }))
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(execute).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
  })

  it('emits a complete text block for the existing message stream', async () => {
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({
        model: { generateText: async () => ({ text: '{"reply":"等待审核"}' }) }
      })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(events.filter((event) => event.type === 'chunk').map((event) => event.chunk.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end'
    ])
  })

  it('turns a thrown tool error into a terminal failure without retrying the write', async () => {
    const execute = vi.fn(async () => {
      throw new Error('unknown write result')
    })
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({
        model: { generateText: async () => ({ text: '{"action":{"tool":"ivideo_start","args":{}}}' }) },
        toolExecutor: { execute }
      })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: new Error('unknown write result') })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not emit completion or tool results after close during a tool call', async () => {
    let finish!: (value: { ok: true; result: string }) => void
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({
        model: { generateText: async () => ({ text: '{"action":{"tool":"ivideo_start","args":{}}}' }) },
        toolExecutor: {
          execute: () =>
            new Promise((resolve) => {
              finish = resolve
            })
        }
      })
    )
    conn.send(userInput('x'))
    await Promise.resolve()
    conn.close()
    finish({ ok: true, result: 'late' })
    await Promise.resolve()
    expect((await collectUntilComplete(conn)).map((e) => (e.type === 'chunk' ? e.chunk.type : e.type))).toEqual([
      'tool-input-available'
    ])
  })

  it('记录带随机调用标识的动作和结果，并只修正明确无副作用的参数错误', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({ text: '{"action":{"tool":"ivideo_start","args":{}}}' })
      .mockResolvedValueOnce({ text: '{"action":{"tool":"ivideo_start","args":{"run":"r1"}}}' })
      .mockResolvedValueOnce({ text: '{"reply":"完成"}' })
    const execute = vi
      .fn<IndustrialVideoStructuredToolExecutor['execute']>()
      .mockResolvedValueOnce({ ok: false, error: '缺少 run', retryable: true })
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: '成功' }] } })
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute } })
    )
    conn.send(userInput('开始'))
    const events = await collectUntilComplete(conn)
    const chunks = events.filter((e) => e.type === 'chunk').map((e) => e.chunk)
    const inputs = chunks.filter((c) => c.type === 'tool-input-available')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.toolCallId).not.toBe(inputs[1]?.toolCallId)
    expect(inputs[0]?.toolCallId).toMatch(/^[0-9a-f-]{36}$/)
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-output-error',
          toolCallId: inputs[0]?.toolCallId,
          errorText: '缺少 run'
        }),
        expect.objectContaining({ type: 'tool-output-available', toolCallId: inputs[1]?.toolCallId })
      ])
    )
    expect(generateText.mock.calls[2][0].transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool: 'ivideo_start',
          args: {},
          toolCallId: inputs[0]?.toolCallId
        }),
        expect.objectContaining({ role: 'tool', toolCallId: inputs[0]?.toolCallId, content: '缺少 run' }),
        expect.objectContaining({
          role: 'assistant',
          tool: 'ivideo_start',
          args: { run: 'r1' },
          toolCallId: inputs[1]?.toolCallId
        }),
        expect.objectContaining({ role: 'tool', toolCallId: inputs[1]?.toolCallId })
      ])
    )
    expect(events.at(-1)).toEqual({ type: 'turn-complete' })
  })

  it('reconcile always reports current', async () => {
    const conn = new IndustrialVideoStructuredConnection(baseDeps())
    expect(await conn.reconcile()).toBe('current')
  })

  it('parse失败时记录安全诊断且不泄露正文或恶意字段，错误停止且工具零执行', async () => {
    const sensitive = '机密工艺参数 secret123 private-run-xyz'
    const generateText = vi.fn(async () => ({
      text: sensitive,
      // 模型可能回传恶意的 diagnostics：非法 finishReason、负/无限/字符串 token、额外字段。
      diagnostics: {
        finishReason: 'EXFILTRATE',
        inputTokens: -5,
        outputTokens: Number.POSITIVE_INFINITY,
        totalTokens: 'huge',
        extraHack: 'leak'
      }
    })) as unknown as IndustrialVideoStructuredModel['generateText']
    const execute = vi.fn()
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute }, stepCap: 16 })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(execute).not.toHaveBeenCalled()
    const calls = mockMainLoggerService.warn.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain('secret123')
    expect(serialized).not.toContain('private-run-xyz')
    expect(serialized).not.toContain('EXFILTRATE')
    expect(serialized).not.toContain('leak')
    for (const call of calls) {
      const ctx = call[1] as Record<string, unknown>
      // 任意未识别 finishReason 收敛为 unknown；恶意数字字段被丢弃而非透传。
      expect(ctx?.finishReason).toBe('unknown')
      expect(ctx).not.toHaveProperty('extraHack')
      expect(ctx?.inputTokens).toBeUndefined()
      expect(ctx?.outputTokens).toBeUndefined()
      expect(ctx?.totalTokens).toBeUndefined()
    }
  })

  it('记录解析位置/布尔与合法token计数，且缺闭合括号时位置准确', async () => {
    const text = '{"reply":"完成"'
    const generateText = vi.fn(async () => ({
      text,
      diagnostics: { finishReason: 'length', inputTokens: 12, outputTokens: 7, totalTokens: 19 }
    })) as unknown as IndustrialVideoStructuredModel['generateText']
    const execute = vi.fn()
    const conn = new IndustrialVideoStructuredConnection(
      baseDeps({ model: { generateText }, toolExecutor: { execute }, stepCap: 16 })
    )
    conn.send(userInput('x'))
    const events = await collectUntilComplete(conn)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    const ctx = mockMainLoggerService.warn.mock.calls[0][1] as Record<string, unknown>
    expect(ctx.startsWithObject).toBe(true)
    expect(ctx.endsWithObject).toBe(false)
    expect(ctx.finishReason).toBe('length')
    expect(ctx.inputTokens).toBe(12)
    expect(ctx.outputTokens).toBe(7)
    expect(ctx.totalTokens).toBe(19)
    expect(ctx.textLength).toBe(text.length)
    expect(typeof ctx.jsonErrorPosition).toBe('number')
  })
})
