import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import type { Topic } from '@renderer/types/topic'
import type { CherryUIMessage } from '@shared/data/types/message'

import { useAgentMessageListProviderValue } from '../agentMessageListAdapter'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

it.each(['general', 'industrial-video'] as const)('仅工业视频注入精简操作策略：%s', (featureKind) => {
  const { result } = renderHook(() =>
    useAgentMessageListProviderValue({
      featureKind,
      topic: { id: 'agent-session:source', assistantId: 'agent-1', name: 'Source', messages: [] } as unknown as Topic,
      messages: [],
      partsByMessageId: {},
      isLoading: false,
      messageNavigation: 'anchor'
    })
  )
  const policy = result.current.meta.actionDisplayPolicy
  if (featureKind === 'general') expect(policy).toBeUndefined()
  else {
    expect(policy?.toolbar).toEqual(['copy', 'user-edit', 'delete', 'usage'])
    expect(policy?.menu).toEqual([])
    expect(policy?.collapseUsage).toBe(true)
    expect(policy?.moreMenuForUser).toBeUndefined()
  }
})

it('offers editing on earlier user messages and disables it while the session is busy', () => {
  const messages: CherryUIMessage[] = [
    { id: 'user-a', role: 'user', parts: [{ type: 'text', text: 'Question A' }] },
    { id: 'assistant-a', role: 'assistant', parts: [{ type: 'text', text: 'Answer A' }] },
    { id: 'user-b', role: 'user', parts: [{ type: 'text', text: 'Question B' }] }
  ]
  const { result, rerender } = renderHook(
    ({ editBusy }) =>
      useAgentMessageListProviderValue({
        topic: { id: 'agent-session:source', assistantId: 'agent-1', name: 'Source', messages: [] } as unknown as Topic,
        messages,
        partsByMessageId: {},
        isLoading: false,
        messageNavigation: 'anchor',
        startEditing: async () => {},
        editBusy
      }),
    { initialProps: { editBusy: false } }
  )
  const [firstUser, assistant, lastUser] = result.current.state.messages
  expect(result.current.actions.canEditMessage!(firstUser)).toBe(true)
  expect(result.current.actions.canEditMessage!(lastUser)).toBe(true)
  expect(result.current.actions.canEditMessage!(assistant)).toBe(false)
  rerender({ editBusy: true })
  expect(result.current.actions.canEditMessage!(firstUser)).toBe(false)
})
