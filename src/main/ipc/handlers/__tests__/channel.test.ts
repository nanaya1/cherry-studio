import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DataApiErrorFactory } from '@shared/data/api/errors'
import { channelErrorCodes } from '@shared/ipc/errors/channel'

const {
  appGetMock,
  createChannelMock,
  deleteChannelMock,
  getPathMock,
  mockNetFetch,
  readFileMock,
  updateChannelMock,
  streamMocks
} = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  createChannelMock: vi.fn(),
  deleteChannelMock: vi.fn(),
  getPathMock: vi.fn(),
  mockNetFetch: vi.fn(),
  readFileMock: vi.fn(),
  updateChannelMock: vi.fn(),
  streamMocks: { connect: vi.fn(), disconnect: vi.fn() }
}))

vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => mockNetFetch(...args) } }))
vi.mock('dingtalk-stream', () => ({
  DWClient: class {
    connect = streamMocks.connect
    disconnect = streamMocks.disconnect
  }
}))
vi.mock('@application', () => ({ application: { get: appGetMock, getPath: getPathMock } }))
vi.mock('fs', () => ({ default: { promises: { readFile: readFileMock } } }))
vi.mock('@main/ai/channels', () => ({
  createAgentChannel: createChannelMock,
  deleteAgentChannel: deleteChannelMock,
  updateAgentChannel: updateChannelMock
}))

import { channelHandlers } from '../channel'

const channelManager = { getChannelLogs: vi.fn() }
const ctx = { senderId: 'w1' }

beforeEach(() => {
  vi.clearAllMocks()
  getPathMock.mockReturnValue('/tokens/weixin_bot_c1.json')
  appGetMock.mockImplementation((name: string) => {
    if (name === 'ChannelManager') return channelManager
    throw new Error(`Unexpected application.get(${name})`)
  })
})

describe('channelHandlers', () => {
  it('create persists desired state through the channel command', async () => {
    const channel = {
      id: 'c1',
      type: 'telegram',
      name: 'Bot',
      workspace: { type: 'system' },
      config: { bot_token: 'token' },
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    createChannelMock.mockReturnValue(channel)
    const input = {
      type: 'telegram' as const,
      name: 'Bot',
      workspace: { type: 'system' as const },
      config: { bot_token: 'token' },
      isActive: true
    }

    await expect(channelHandlers['channel.create'](input, ctx)).resolves.toBe(channel)
    expect(createChannelMock).toHaveBeenCalledWith(input)
  })

  it('update exposes service validation as a channel-domain IPC error', async () => {
    updateChannelMock.mockImplementation(() => {
      throw DataApiErrorFactory.validation({ bot_token: ['Required'] })
    })

    await expect(
      channelHandlers['channel.update']({ channelId: 'c1', updates: { isActive: true } }, ctx)
    ).rejects.toMatchObject({ code: channelErrorCodes.CHANNEL_CONFIG_INVALID })
  })

  it('delete reports a missing channel with a stable domain error', async () => {
    deleteChannelMock.mockResolvedValue(false)

    await expect(channelHandlers['channel.delete']({ channelId: 'missing' }, ctx)).rejects.toMatchObject({
      code: channelErrorCodes.CHANNEL_NOT_FOUND
    })
  })

  it('wechat.has_credentials returns exists + userId when the token file parses', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ userId: 'u1' }))
    expect(await channelHandlers['channel.wechat.has_credentials']('c1', ctx)).toEqual({ exists: true, userId: 'u1' })
    expect(getPathMock).toHaveBeenCalledWith('feature.agents.channels', 'weixin_bot_c1.json')
  })

  it('wechat.has_credentials returns { exists: false } on any read/parse failure', async () => {
    readFileMock.mockRejectedValue(new Error('nope'))
    expect(await channelHandlers['channel.wechat.has_credentials']('c1', ctx)).toEqual({ exists: false })
  })

  it('DingTalk connection test reports invalid credentials before opening Stream', async () => {
    mockNetFetch.mockResolvedValue({ ok: false, status: 401 })

    await expect(
      channelHandlers['channel.dingtalk.test_connection']({ client_id: 'client', client_secret: 'secret' }, ctx)
    ).resolves.toEqual({ connected: false, message: 'credentials_invalid' })
    expect(mockNetFetch).toHaveBeenCalledWith(
      'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      expect.objectContaining({ method: 'POST' })
    )
    expect(streamMocks.connect).not.toHaveBeenCalled()
  })

  it('DingTalk connection test validates the token and then connects Stream', async () => {
    mockNetFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ accessToken: 'token' }) })

    await expect(
      channelHandlers['channel.dingtalk.test_connection']({ client_id: 'client', client_secret: 'secret' }, ctx)
    ).resolves.toEqual({ connected: true, message: 'connected' })
    expect(streamMocks.connect).toHaveBeenCalledOnce()
    expect(streamMocks.disconnect).toHaveBeenCalledOnce()
  })

  it('DingTalk connection test reports Stream timeout and disconnects the temporary client', async () => {
    vi.useFakeTimers()
    mockNetFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ accessToken: 'token' }) })
    streamMocks.connect.mockReturnValue(new Promise(() => undefined))

    const result = channelHandlers['channel.dingtalk.test_connection'](
      { client_id: 'client', client_secret: 'secret' },
      ctx
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(result).resolves.toEqual({ connected: false, message: 'timeout' })
    expect(streamMocks.disconnect).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('get_logs delegates to ChannelManager', async () => {
    channelManager.getChannelLogs.mockReturnValue([{ timestamp: 1, level: 'info', message: 'm', channelId: 'c1' }])
    expect(await channelHandlers['channel.get_logs']('c1', ctx)).toEqual([
      { timestamp: 1, level: 'info', message: 'm', channelId: 'c1' }
    ])
    expect(channelManager.getChannelLogs).toHaveBeenCalledWith('c1')
  })
})
