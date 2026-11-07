import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataApiError, ErrorCode } from '@shared/data/api/errors'

const mocks = vi.hoisted(() => ({
  getPersist: vi.fn(),
  get: vi.fn()
}))

vi.mock('@data/CacheService', () => ({
  cacheService: { getPersist: mocks.getPersist }
}))

vi.mock('@data/DataApiService', () => ({
  dataApiService: { get: mocks.get }
}))

import {
  resolveAgentEntrySessionId,
  resolveAgentEntrySessionIdForAgent,
  resolveChatEntryTopicId,
  resolveChatEntryTopicIdForAssistant
} from '@renderer/utils/conversationEntry'

const notFoundError = () => new DataApiError(ErrorCode.NOT_FOUND, 'not found', 404)

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveChatEntryTopicId', () => {
  it('resolves the last-used topic when it still exists', async () => {
    mocks.getPersist.mockReturnValue('topic-last')
    mocks.get.mockResolvedValue({ id: 'topic-last' })

    await expect(resolveChatEntryTopicId()).resolves.toBe('topic-last')
    expect(mocks.getPersist).toHaveBeenCalledWith('ui.chat.last_used_topic_id')
    expect(mocks.get).toHaveBeenCalledWith('/topics/topic-last')
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('falls through to the latest topic when the last-used topic was deleted', async () => {
    mocks.getPersist.mockReturnValue('topic-deleted')
    mocks.get.mockRejectedValueOnce(notFoundError()).mockResolvedValueOnce({ topic: { id: 'topic-latest' } })

    await expect(resolveChatEntryTopicId()).resolves.toBe('topic-latest')
    expect(mocks.get).toHaveBeenNthCalledWith(2, '/topics/latest')
  })

  it('asks for the latest topic when nothing is remembered', async () => {
    mocks.getPersist.mockReturnValue(null)
    mocks.get.mockResolvedValue({ topic: { id: 'topic-latest' } })

    await expect(resolveChatEntryTopicId()).resolves.toBe('topic-latest')
    expect(mocks.get).toHaveBeenCalledWith('/topics/latest')
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('returns null when the library is empty', async () => {
    mocks.getPersist.mockReturnValue(null)
    mocks.get.mockResolvedValue({ topic: null })

    await expect(resolveChatEntryTopicId()).resolves.toBeNull()
  })

  it('performs a fresh latest read on each entry resolution', async () => {
    mocks.getPersist.mockReturnValue(null)
    mocks.get.mockResolvedValueOnce({ topic: { id: 'topic-first' } }).mockResolvedValueOnce({ topic: null })

    await expect(resolveChatEntryTopicId()).resolves.toBe('topic-first')
    await expect(resolveChatEntryTopicId()).resolves.toBeNull()
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })

  it('rethrows non-NOT_FOUND validation errors instead of silently rebinding', async () => {
    mocks.getPersist.mockReturnValue('topic-last')
    const serverError = new DataApiError(ErrorCode.INTERNAL_SERVER_ERROR, 'boom', 500)
    mocks.get.mockRejectedValue(serverError)

    await expect(resolveChatEntryTopicId()).rejects.toBe(serverError)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
})

describe('resolveAgentEntrySessionId', () => {
  it('忽略旧最近键中的视频会话，并仅回退普通分类', async () => {
    mocks.getPersist.mockReturnValue('video-last')
    mocks.get
      .mockResolvedValueOnce({ id: 'video-last', featureKind: 'industrial-video' })
      .mockResolvedValueOnce({ session: { id: 'general-last' } })

    await expect(resolveAgentEntrySessionId()).resolves.toBe('general-last')
    expect(mocks.get).toHaveBeenLastCalledWith('/agent-sessions/latest', { query: { featureKind: 'general' } })
  })

  it('无最近键时只恢复普通分类', async () => {
    mocks.getPersist.mockReturnValue(null)
    mocks.get.mockResolvedValue({ session: { id: 'general-last' } })
    await expect(resolveAgentEntrySessionId()).resolves.toBe('general-last')
    expect(mocks.get).toHaveBeenCalledWith('/agent-sessions/latest', { query: { featureKind: 'general' } })
  })
  it('resolves the last-used session when it still exists', async () => {
    mocks.getPersist.mockReturnValue('session-last')
    mocks.get.mockResolvedValue({ id: 'session-last' })

    await expect(resolveAgentEntrySessionId()).resolves.toBe('session-last')
    expect(mocks.getPersist).toHaveBeenCalledWith('ui.agent.last_used_session_id')
    expect(mocks.get).toHaveBeenCalledWith('/agent-sessions/session-last')
  })

  it('falls through to the latest session when the last-used session was deleted', async () => {
    mocks.getPersist.mockReturnValue('session-deleted')
    mocks.get.mockRejectedValueOnce(notFoundError()).mockResolvedValueOnce({ session: { id: 'session-latest' } })

    await expect(resolveAgentEntrySessionId()).resolves.toBe('session-latest')
    expect(mocks.get).toHaveBeenNthCalledWith(2, '/agent-sessions/latest', { query: { featureKind: 'general' } })
  })

  it('returns null when no sessions exist', async () => {
    mocks.getPersist.mockReturnValue(null)
    mocks.get.mockResolvedValue({ session: null })

    await expect(resolveAgentEntrySessionId()).resolves.toBeNull()
  })
})

describe('resolveChatEntryTopicIdForAssistant', () => {
  it('resolves the latest topic of the given assistant', async () => {
    mocks.get.mockResolvedValue({ topic: { id: 'topic-assistant' } })

    await expect(resolveChatEntryTopicIdForAssistant('assistant-1')).resolves.toBe('topic-assistant')
    expect(mocks.get).toHaveBeenCalledWith('/topics/latest', { query: { assistantId: 'assistant-1' } })
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('returns null when the assistant has no topics', async () => {
    mocks.get.mockResolvedValue({ topic: null })

    await expect(resolveChatEntryTopicIdForAssistant('assistant-1')).resolves.toBeNull()
  })

  it('never consults the global last-focused topic cache', async () => {
    mocks.getPersist.mockReturnValue('topic-global')
    mocks.get.mockResolvedValue({ topic: { id: 'topic-assistant' } })

    await expect(resolveChatEntryTopicIdForAssistant('assistant-1')).resolves.toBe('topic-assistant')
    expect(mocks.getPersist).not.toHaveBeenCalled()
  })
})

describe('resolveAgentEntrySessionIdForAgent', () => {
  it.each([true, false])('同 agent 最新为视频、存在较早普通任务=%s 时只恢复普通任务', async (hasGeneral) => {
    const sessions = [
      { id: 'video-newest', agentId: 'agent-1', featureKind: 'industrial-video' },
      ...(hasGeneral ? [{ id: 'general-older', agentId: 'agent-1', featureKind: 'general' }] : [])
    ]
    mocks.get.mockImplementation(async (_path, options) => ({
      session:
        sessions.find(
          (session) =>
            session.agentId === options.query.agentId &&
            (!options.query.featureKind || session.featureKind === options.query.featureKind)
        ) ?? null
    }))

    await expect(resolveAgentEntrySessionIdForAgent('agent-1')).resolves.toBe(hasGeneral ? 'general-older' : null)
  })

  it('resolves the latest session of the given agent', async () => {
    mocks.get.mockResolvedValue({ session: { id: 'session-agent' } })

    await expect(resolveAgentEntrySessionIdForAgent('agent-1')).resolves.toBe('session-agent')
    expect(mocks.get).toHaveBeenCalledWith('/agent-sessions/latest', {
      query: { agentId: 'agent-1', featureKind: 'general' }
    })
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('returns null when the agent has no sessions', async () => {
    mocks.get.mockResolvedValue({ session: null })

    await expect(resolveAgentEntrySessionIdForAgent('agent-1')).resolves.toBeNull()
  })

  it('never consults the global last-focused session cache', async () => {
    mocks.getPersist.mockReturnValue('session-global')
    mocks.get.mockResolvedValue({ session: { id: 'session-agent' } })

    await expect(resolveAgentEntrySessionIdForAgent('agent-1')).resolves.toBe('session-agent')
    expect(mocks.getPersist).not.toHaveBeenCalled()
  })
})
