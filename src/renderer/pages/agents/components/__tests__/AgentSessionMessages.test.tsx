import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PropsWithChildren, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentSessionMessages from '../AgentSessionMessages'

const useAgentMessageListProviderValueMock = vi.hoisted(() =>
  vi.fn((value?: { messageTail?: { content?: ReactNode } }) => ({
    state: { messageTail: value?.messageTail },
    actions: {},
    meta: {}
  }))
)
const ipcRequestMock = vi.hoisted(() =>
  vi.fn<(route: string, input?: unknown) => Promise<unknown>>(async () => undefined)
)
const stream = vi.hoisted(() => ({ isPending: false }))
vi.mock('@renderer/hooks/useTopicStreamStatus', () => ({ useTopicStreamStatus: () => stream }))
vi.mock('../../../industrialVideo/IndustrialVideoReviewFiles', () => ({ default: () => null }))
vi.mock('../../../industrialVideo/useIndustrialVideoProduction', () => ({
  useIndustrialVideoProduction: () => ({
    record: { sessionId: 'session-1', run: 'run-1', state: 'storyboard_submitted', control: { phase: 'idle' }, unknownSubmissions: [], rounds: [] },
    refresh: async () => undefined
  })
}))

vi.mock('@renderer/components/chat/messages/MessageList', () => ({
  default: () => {
    const input = useAgentMessageListProviderValueMock.mock.calls.at(-1)?.[0]
    return <div data-testid="message-list">{input?.messageTail?.content}</div>
  }
}))

vi.mock('@renderer/components/chat/messages/MessageListProvider', () => ({
  useOptionalMessageListActions: () => null,
  MessageListProvider: ({ children }: PropsWithChildren) => <div data-testid="message-list-provider">{children}</div>
}))

vi.mock('@renderer/data/hooks/usePreference', () => ({
  usePreference: () => ['anchor']
}))

vi.mock('@renderer/hooks/agent/useSession', () => ({
  useSession: () => ({
    session: {
      id: 'session-1',
      agentId: 'agent-1',
      name: 'Agent session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      featureKind: 'industrial-video'
    }
  })
}))

vi.mock('../../messages/agentMessageListAdapter', () => ({
  useAgentMessageListProviderValue: useAgentMessageListProviderValueMock
}))

vi.mock('../../messages/AgentSessionBackgroundTasks', () => ({
  default: () => null
}))

// The mount effect fires ipcApi.request('ai.agent.session.prewarm' / 'ai.agent.session.close_warm');
// the lease test below asserts on those calls.
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: ipcRequestMock, on: vi.fn(() => () => {}) }
}))

describe('AgentSessionMessages', () => {
  beforeEach(() => {
    useAgentMessageListProviderValueMock.mockClear()
    ipcRequestMock.mockClear()
  })

  it('历史已加载但模型仍在输出时不读取审核，输出结束后自动读取', async () => {
    stream.isPending = true
    const props = {
      sessionId: 'session-1',
      messages: [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: '正在保存预览' }] }] as any,
      partsByMessageId: {},
      isLoading: false
    }
    const view = render(<AgentSessionMessages {...props} />)
    try {
      expect(ipcRequestMock.mock.calls.some(([route]) => route === 'industrial_video.cowork_review_get')).toBe(false)
      stream.isPending = false
      view.rerender(<AgentSessionMessages {...props} messages={[...props.messages]} />)
      expect(ipcRequestMock).toHaveBeenCalledWith('industrial_video.cowork_review_get', {
        sessionId: 'session-1',
        run: 'run-1'
      })
    } finally {
      view.unmount()
      stream.isPending = false
    }
  })

  it('normalizes blank agent avatars before passing the assistant profile to the message list', () => {
    render(
      <AgentSessionMessages
        agentId="agent-1"
        sessionId="session-1"
        messages={[]}
        activeAgent={{ id: 'agent-1', name: 'Blank avatar agent', configuration: { avatar: '   ' } } as any}
        partsByMessageId={{}}
        isLoading={false}
      />
    )

    expect(useAgentMessageListProviderValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantProfile: {
          name: 'Blank avatar agent',
          avatar: '🤖'
        }
      })
    )
  })

  it('acquires the session warm lease on mount and releases it only on unmount', () => {
    const view = render(
      <AgentSessionMessages
        agentId="agent-1"
        sessionId="session-1"
        messages={[]}
        partsByMessageId={{}}
        isLoading={false}
      />
    )

    expect(ipcRequestMock).toHaveBeenCalledWith('ai.agent.session.prewarm', { sessionId: 'session-1' })
    expect(ipcRequestMock).not.toHaveBeenCalledWith('ai.agent.session.close_warm', { sessionId: 'session-1' })

    view.unmount()
    expect(ipcRequestMock).toHaveBeenCalledWith('ai.agent.session.close_warm', { sessionId: 'session-1' })
  })

  it('工业会话不从模型文字另造旁路生成按钮', () => {
    const sendMessage = vi.fn(async () => true)
    render(
      <AgentSessionMessages
        agentId="agent-1"
        sessionId="session-1"
        messages={
          [
            {
              id: 'assistant-handoff',
              role: 'assistant',
              parts: [{ type: 'text', text: '确认后，在对话框发送「开始生成视频」。' }]
            }
          ] as any
        }
        partsByMessageId={{}}
        isLoading={false}
        sendMessage={sendMessage}
      />
    )

    expect(screen.queryByRole('button', { name: '开始生成视频' })).toBeNull()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('工业消息尾审核确认后发送生成消息且不直接提交视频', async () => {
    const sendMessage = vi.fn(async () => true)
    ipcRequestMock.mockImplementation(async (route: string) =>
      route === 'industrial_video.cowork_review_get'
        ? { review_version: 'rv-1', script: '全文', storyboard: { scenes: [] }, allowed_actions: ['generate_video'] }
        : route === 'industrial_video.cowork_review_confirm'
          ? { generation_allowed: true, remaining_blockers: [], next_stage: 'video' }
          : undefined
    )
    render(
      <AgentSessionMessages
        agentId="agent-1"
        sessionId="session-1"
        messages={[{ id: 'assistant-review', role: 'assistant', parts: [{ type: 'text', text: '预览已保存' }] }] as any}
        partsByMessageId={{}}
        isLoading={false}
        sendMessage={sendMessage}
      />
    )
    await screen.findByRole('region', { name: '客户端审核' })
    await screen.findByText('已同步最新内容')
    await userEvent.setup().click(screen.getByRole('button', { name: '确认并生成视频' }))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ text: '开始生成视频' }))
    expect(ipcRequestMock.mock.calls.some(([route]) => route === 'industrial_video.video_start')).toBe(false)
    ipcRequestMock.mockReset()
  })

  it('anchors background status to the latest assistant with content instead of an empty pending placeholder', () => {
    const settledAssistant = {
      id: 'assistant-settled',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Main answer' }]
    }
    const pendingAssistant = {
      id: 'assistant-pending',
      role: 'assistant',
      parts: []
    }

    render(
      <AgentSessionMessages
        agentId="agent-1"
        sessionId="session-1"
        messages={[settledAssistant, { id: 'user-follow-up', role: 'user', parts: [] }, pendingAssistant] as any}
        partsByMessageId={{
          'assistant-settled': [{ type: 'text', text: 'Main answer' }] as any
        }}
        isLoading={false}
      />
    )

    expect(useAgentMessageListProviderValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTail: expect.objectContaining({
          messageId: 'assistant-settled'
        })
      })
    )
  })
})
