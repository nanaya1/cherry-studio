import type { UIMessageChunk } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import { pipeStreamLoop } from '../pipeStreamLoop'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    readUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error('accumulator boom'))
        }
      })
  }
})

describe('pipeStreamLoop', () => {
  it('reports accumulator failures without losing broadcast chunks', async () => {
    let controller!: ReadableStreamDefaultController<UIMessageChunk>
    const stream = new ReadableStream<UIMessageChunk>({
      start(nextController) {
        controller = nextController
      }
    })
    const seen: UIMessageChunk[] = []

    const resultPromise = pipeStreamLoop(stream, new AbortController().signal, {
      onChunk: (chunk) => seen.push(chunk)
    })
    controller.enqueue({ type: 'text-start', id: 'part-1' })
    controller.enqueue({ type: 'text-delta', id: 'part-1', delta: 'partial' })
    controller.close()

    const result = await resultPromise

    expect(seen).toEqual([
      { type: 'text-start', id: 'part-1' },
      { type: 'text-delta', id: 'part-1', delta: 'partial' }
    ])
    expect(result.accumulatorError).toEqual(new Error('accumulator boom'))
  })
})
