import { describe, expect, it } from 'vitest'

import { resolveDefaultAssistant } from '../assistant'

const assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }, { id: 'assistant-3' }]

describe('resolveDefaultAssistant', () => {
  it('preserves an explicit runtime fallback selection', () => {
    expect(
      resolveDefaultAssistant(assistants, {
        explicitAssistantId: null,
        preferredAssistantId: 'assistant-1',
        lastUsedAssistantId: 'assistant-2'
      })
    ).toEqual({ source: 'explicit' })
  })

  it('resolves valid assistants in explicit, preferred, and last-used priority order', () => {
    expect(
      resolveDefaultAssistant(assistants, {
        explicitAssistantId: 'assistant-1',
        preferredAssistantId: 'assistant-2',
        lastUsedAssistantId: 'assistant-3'
      })
    ).toEqual({ assistantId: 'assistant-1', source: 'explicit' })

    expect(
      resolveDefaultAssistant(assistants, {
        explicitAssistantId: 'deleted',
        preferredAssistantId: 'assistant-2',
        lastUsedAssistantId: 'assistant-3'
      })
    ).toEqual({ assistantId: 'assistant-2', source: 'preferred' })

    expect(
      resolveDefaultAssistant(assistants, {
        preferredAssistantId: 'deleted',
        lastUsedAssistantId: 'assistant-3'
      })
    ).toEqual({ assistantId: 'assistant-3', source: 'last-used' })
  })

  it('falls back to the first available non-excluded assistant', () => {
    expect(
      resolveDefaultAssistant(assistants, {
        lastUsedAssistantId: 'assistant-1',
        excludedAssistantIds: ['assistant-1', 'assistant-2']
      })
    ).toEqual({ assistantId: 'assistant-3', source: 'first-assistant' })
  })

  it('uses the runtime fallback when no assistant is available', () => {
    expect(resolveDefaultAssistant([], { lastUsedAssistantId: 'deleted' })).toEqual({ source: 'runtime-fallback' })
  })
})
