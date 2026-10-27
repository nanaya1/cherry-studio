import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

const mockNetFetch = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => mockNetFetch(...args) } }))

const sdkMocks = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), register: vi.fn(), respond: vi.fn() }))
vi.mock('dingtalk-stream', () => ({
  DWClient: class {
    connect = sdkMocks.connect
    disconnect = sdkMocks.disconnect
    registerCallbackListener = sdkMocks.register
    socketCallBackResponse = sdkMocks.respond
  },
  EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get'
}))

import { createDingTalkAdapter } from '../dingtalk/DingTalkAdapter'

function createAdapter(
  config: {
    client_id: string
    client_secret: string
    robot_code?: string
    allowed_chat_ids: string[]
    require_mention: boolean
  } = { client_id: 'client', client_secret: 'secret', allowed_chat_ids: [], require_mention: true }
): any {
  return createDingTalkAdapter({
    channelId: 'channel-1',
    channelType: 'dingtalk',
    agentId: 'agent-1',
    channelConfig: config
  })
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'cid-1',
    conversationType: '1',
    msgId: 'msg-1',
    senderId: 'sender-1',
    senderStaffId: 'staff-1',
    senderNick: 'Sender',
    chatbotUserId: 'bot-1',
    msgtype: 'text',
    text: { content: 'hello' },
    sessionWebhook: 'https://example.test/webhook',
    sessionWebhookExpiredTime: Date.now() + 60_000,
    ...overrides
  }
}

afterEach(() => {
  vi.clearAllMocks()
  mockNetFetch.mockReset()
  sdkMocks.connect.mockResolvedValue(undefined)
})

describe('DingTalkAdapter', () => {
  it('registers the robot callback and connects Stream', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    expect(sdkMocks.register).toHaveBeenCalledWith('/v1.0/im/bot/messages/get', expect.any(Function))
    expect(adapter.connected).toBe(true)
    await adapter.disconnect()
    expect(sdkMocks.disconnect).toHaveBeenCalled()
  })

  it('maps an inbound text event and ACKs the callback', async () => {
    const adapter = createAdapter()
    const events: unknown[] = []
    adapter.on('message', (event: unknown) => events.push(event))
    await adapter.connect()
    const callback = sdkMocks.register.mock.calls[0][1]
    await callback({ data: JSON.stringify(message()), headers: { messageId: 'stream-msg-1' } })
    expect(events).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        userId: 'staff-1',
        userName: 'Sender',
        text: 'hello',
        messageId: 'msg-1'
      })
    ])
    expect(sdkMocks.respond).toHaveBeenCalledWith('stream-msg-1', { status: 'SUCCESS' })
  })

  it('filters groups unless DingTalk marks the bot as mentioned and enforces the allowlist', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      allowed_chat_ids: ['allowed'],
      require_mention: true
    })
    const events: unknown[] = []
    adapter.on('message', (event: unknown) => events.push(event))
    await adapter.handleRobotMessage(
      message({ msgId: 'msg-1', conversationType: '2', conversationId: 'allowed', text: { content: '@bot-1 hello' } })
    )
    await adapter.handleRobotMessage(
      message({ msgId: 'msg-2', conversationType: '2', conversationId: 'not-allowed', isInAtList: true })
    )
    await adapter.handleRobotMessage(
      message({ msgId: 'msg-3', conversationType: '2', conversationId: 'allowed', isInAtList: true })
    )
    expect(events).toEqual([expect.objectContaining({ chatId: 'allowed', text: 'hello', messageId: 'msg-3' })])
  })

  it('uses the session webhook for inbound replies and OpenAPI for proactive delivery', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: [],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.handleRobotMessage(message({ conversationType: '2', isInAtList: true }))
    await adapter.sendMessage('cid-1', 'reply', { replyToMessageId: 'msg-1' })
    await adapter.sendMessage('cid-1', 'automation')
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      1,
      'https://example.test/webhook',
      expect.objectContaining({ method: 'POST' })
    )
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      expect.objectContaining({ method: 'POST' })
    )
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-acs-dingtalk-access-token': 'token-1' })
      })
    )
  })

  it('sends proactive group messages through the group API and reuses the access token', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: [],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.handleRobotMessage(message({ conversationType: '2', isInAtList: true, msgId: 'group-msg-1' }))
    await adapter.sendMessage('cid-1', 'first')
    await adapter.sendMessage('cid-1', 'second')
    expect(mockNetFetch).toHaveBeenCalledTimes(3)
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        body: expect.stringContaining('"openConversationId":"cid-1"')
      })
    )
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-acs-dingtalk-access-token': 'token-1' })
      })
    )
  })

  it('sends proactive one-to-one messages to the inbound sender user id', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: [],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.handleRobotMessage(
      message({ conversationId: 'user-conversation-1', conversationType: '1', senderStaffId: 'staff-42' })
    )
    await adapter.sendMessage('user-conversation-1', 'automation')
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      expect.objectContaining({
        body: expect.stringContaining('"userIds":["staff-42"]')
      })
    )
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        body: expect.not.stringContaining('openConversationId')
      })
    )
  })

  it('rejects an unknown proactive target instead of guessing the group API', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: [],
      require_mention: true
    })
    await expect(adapter.sendMessage('unknown-target', 'automation')).rejects.toThrow('target type is unknown')
    expect(mockNetFetch).not.toHaveBeenCalled()
  })

  it('keeps configured allowlist targets compatible as proactive groups', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: ['configured-group'],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.sendMessage('configured-group', 'automation')
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.any(Object)
    )
  })

  it('defaults the robot code to client_id when robot_code is not configured', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      allowed_chat_ids: ['cid-1'],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.handleRobotMessage(message({ conversationType: '2', isInAtList: true }))
    await adapter.sendMessage('cid-1', 'automation')
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        body: expect.stringContaining('"robotCode":"client"')
      })
    )
  })

  it('honors an explicit robot_code over the client_id default', async () => {
    const adapter = createAdapter({
      client_id: 'client',
      client_secret: 'secret',
      robot_code: 'robot-1',
      allowed_chat_ids: ['cid-1'],
      require_mention: true
    })
    mockNetFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    await adapter.handleRobotMessage(message({ conversationType: '2', isInAtList: true }))
    await adapter.sendMessage('cid-1', 'automation')
    expect(mockNetFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        body: expect.stringContaining('"robotCode":"robot-1"')
      })
    )
  })

  it('does not expose webhook values in send failures', async () => {
    const adapter = createAdapter()
    mockNetFetch.mockResolvedValue({ ok: false, status: 403 })
    await adapter.handleRobotMessage(message())
    await expect(adapter.sendMessage('cid-1', 'reply', { replyToMessageId: 'msg-1' })).rejects.toThrow('HTTP 403')
  })

  it('returns a retryable ACK when the callback payload is not an object', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    const callback = sdkMocks.register.mock.calls[0][1]

    await callback({ data: JSON.stringify(null), headers: { messageId: 'invalid-payload' } })

    expect(sdkMocks.respond).toHaveBeenCalledWith('invalid-payload', { status: 'LATER' })
  })

  it('times out a stalled Stream connection and cleans up the client', async () => {
    vi.useFakeTimers()
    sdkMocks.connect.mockReturnValue(new Promise(() => undefined))
    const adapter = createAdapter()
    const connecting = expect(adapter.connect()).rejects.toThrow('DingTalk Stream connection timed out')

    await vi.advanceTimersByTimeAsync(15_000)
    await connecting
    expect(sdkMocks.disconnect).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('times out a stalled webhook request', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    mockNetFetch.mockReturnValue(new Promise(() => undefined))
    await adapter.handleRobotMessage(message())
    const sending = expect(adapter.sendMessage('cid-1', 'reply', { replyToMessageId: 'msg-1' })).rejects.toThrow(
      'DingTalk reply request timed out'
    )

    await vi.advanceTimersByTimeAsync(15_000)
    await sending
    vi.useRealTimers()
  })
})
