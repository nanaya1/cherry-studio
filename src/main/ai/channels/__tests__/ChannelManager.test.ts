import { defaultServiceInstances } from '@test-mocks/main/application'
import { MockMainCacheServiceExport } from '@test-mocks/main/CacheService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentChannelService as channelService } from '@data/services/AgentChannelService'
import { BaseService, DependsOn, Injectable, LifecycleManager, Phase, ServiceContainer } from '@main/core/lifecycle'

import { ChannelAdapter, type ChannelAdapterConfig } from '../ChannelAdapter'
import { loadChannelAdapter } from '../channelAdapterLoader'
import { ChannelManager } from '../ChannelManager'
import { channelMessageHandler } from '../ChannelMessageHandler'

const mocks = vi.hoisted(() => ({
  getLifecycleState: vi.fn(),
  stopStream: vi.fn(),
  stopRuntime: vi.fn()
}))

vi.mock('../channelAdapterLoader', () => ({ loadChannelAdapter: vi.fn() }))

@Injectable('WindowManager')
class TestWindowManager {
  constructor() {
    Object.assign(this, defaultServiceInstances.WindowManager)
  }
}

@Injectable('AiStreamManager')
class TestAiStreamManager extends BaseService {
  protected override onStop(): void {
    mocks.stopStream()
  }
}

@Injectable('AgentSessionRuntimeService')
@DependsOn(['WindowManager'])
class TestAgentSessionRuntime extends BaseService {
  protected override onStop(): void {
    mocks.stopRuntime()
  }
}

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@data/services/AgentService', () => ({
  agentService: {
    getLifecycleState: mocks.getLifecycleState
  }
}))

vi.mock('@data/services/AgentChannelService', () => ({
  agentChannelService: {
    listChannels: vi.fn().mockReturnValue([]),
    getChannel: vi.fn(),
    updateChannel: vi.fn(),
    addActiveChatId: vi.fn()
  }
}))

vi.mock('../ChannelMessageHandler', () => ({
  channelMessageHandler: {
    isWriteQuiesced: false,
    handleIncoming: vi.fn().mockResolvedValue(undefined),
    handleCommand: vi.fn().mockResolvedValue(undefined),
    clearSessionTracker: vi.fn(),
    pause: vi.fn(),
    drainInFlight: vi.fn(),
    drainTurns: vi.fn().mockResolvedValue(undefined),
    acquireShutdownPause: vi.fn(),
    releaseShutdownPause: vi.fn(),
    clearSessionTrackerBindings: vi.fn(),
    listActiveWork: vi.fn()
  }
}))

class MockAdapter extends ChannelAdapter {
  connect = vi.fn().mockResolvedValue(undefined)
  disconnect = vi.fn().mockResolvedValue(undefined)
  sendMessage = vi.fn().mockResolvedValue(undefined)
  sendTypingIndicator = vi.fn().mockResolvedValue(undefined)

  protected async performConnect(): Promise<void> {}
  protected async performDisconnect(): Promise<void> {}

  constructor(config: ChannelAdapterConfig) {
    super(config)
  }
}

describe('ChannelManager', () => {
  let rows: any[]
  let adapters: MockAdapter[]
  let manager: ChannelManager
  let qrOnConnect: string | undefined

  const makeChannel = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    type: 'telegram' as const,
    name: 'Test',
    agentId: 'agent-1',
    sessionId: null,
    workspace: { type: 'system' as const },
    config: { bot_token: 'token', allowed_chat_ids: [] },
    isActive: true,
    activeChatIds: [],
    permissionMode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  })

  beforeEach(() => {
    BaseService.resetInstances()
    ServiceContainer.reset()
    vi.clearAllMocks()
    mocks.getLifecycleState.mockReturnValue('active')
    rows = []
    adapters = []
    qrOnConnect = undefined
    vi.mocked(channelService.listChannels).mockImplementation((filters) =>
      filters?.agentId ? rows.filter((row) => row.agentId === filters.agentId) : rows
    )
    vi.mocked(channelService.getChannel).mockImplementation(
      (channelId) => rows.find((row) => row.id === channelId) ?? null
    )
    vi.mocked(loadChannelAdapter).mockImplementation(async (channel, agentId) => {
      const adapter = new MockAdapter({
        channelId: channel.id,
        channelType: channel.type,
        agentId,
        channelConfig: channel.config
      })
      adapter.connect.mockImplementation(async () => {
        if (qrOnConnect) adapter.emit('qr', qrOnConnect)
      })
      adapters.push(adapter)
      return adapter
    })
    const container = ServiceContainer.getInstance()
    container.register(TestWindowManager)
    container.register(ChannelManager)
    container.register(TestAiStreamManager)
    container.register(TestAgentSessionRuntime)
    manager = container.get(ChannelManager)
  })

  afterEach(async () => {
    // Reset the drain mock so the lifecycle _doStop (which also calls stop) never hangs or rejects.
    vi.mocked(channelMessageHandler.drainTurns).mockResolvedValue(undefined)
    await manager._doStop()
    BaseService.resetInstances()
    ServiceContainer.reset()
  })

  it('finishes channel turns before stopping the AI runtime regardless of registration order', async () => {
    const order: string[] = []
    mocks.stopStream.mockImplementation(() => order.push('stream:stop'))
    mocks.stopRuntime.mockImplementation(() => order.push('runtime:stop'))
    LifecycleManager.reset()
    const lifecycle = LifecycleManager.getInstance()
    let finish!: () => void
    vi.mocked(channelMessageHandler.drainTurns).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('channel:drain')
          finish = resolve
        })
    )
    try {
      await lifecycle.startPhase(Phase.WhenReady)
      const stopping = lifecycle.stopAll()
      await vi.waitFor(() => expect(order).toContain('channel:drain'))
      const beforeFinish = [...order]
      finish()
      const result = await stopping
      expect(beforeFinish).toEqual(['channel:drain'])
      expect(result).toEqual({ timedOut: [], failed: [] })
      expect(order.slice(1).sort()).toEqual(['runtime:stop', 'stream:stop'])
    } finally {
      LifecycleManager.reset()
    }
  })

  it('connects only when both channel intent and Agent lifecycle are active', async () => {
    rows = [makeChannel(), makeChannel({ id: 'ch-paused', isActive: false })]
    mocks.getLifecycleState.mockImplementation((agentId) => (agentId === 'agent-1' ? 'active' : 'trashed'))

    await manager.start()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))

    expect(adapters[0].channelId).toBe('ch-1')
    expect(adapters[0].connect).toHaveBeenCalledOnce()
  })

  it('treats archive and restore events as hints and preserves channel intent', async () => {
    rows = [makeChannel()]
    await manager._doInit()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))

    mocks.getLifecycleState.mockReturnValue('trashed')
    manager.reconcileAgent('agent-1', true)
    await vi.waitFor(() => expect(adapters[0].disconnect).toHaveBeenCalledOnce())

    expect(rows[0].isActive).toBe(true)
    expect(rows[0].agentId).toBe('agent-1')
    expect(channelService.updateChannel).not.toHaveBeenCalled()
    expect(channelMessageHandler.clearSessionTracker).toHaveBeenCalledWith('agent-1')

    mocks.getLifecycleState.mockReturnValue('active')
    manager.reconcileAgent('agent-1')
    await vi.waitFor(() => expect(adapters).toHaveLength(2))
    expect(adapters[1].connect).toHaveBeenCalledOnce()
  })

  it('disconnects after purge even though the Agent foreign key was already cleared', async () => {
    rows = [makeChannel()]
    await manager._doInit()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))

    rows[0] = makeChannel({ agentId: null })
    manager.reconcileAgent('agent-1', true)

    await vi.waitFor(() => expect(adapters[0].disconnect).toHaveBeenCalledOnce())
    expect(rows[0].isActive).toBe(true)
    expect(adapters).toHaveLength(1)
  })

  it('clears runtime state, status, logs, and adapters when the channel entity is deleted', async () => {
    rows = [makeChannel()]
    await manager.start()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))
    adapters[0].emit('log', { timestamp: 1, level: 'info', message: 'connected', channelId: 'ch-1' })
    adapters[0].emit('statusChange', { channelId: 'ch-1', connected: true })
    expect(manager.getChannelLogs('ch-1')).toHaveLength(1)

    rows = []
    await manager.removeChannel('ch-1')

    expect(manager.getAdapter('ch-1')).toBeUndefined()
    expect(manager.getChannelLogs('ch-1')).toEqual([])
    expect(MockMainCacheServiceExport.cacheService.getShared('channel.status.ch-1')).toBeUndefined()
  })

  it('installs the QR waiter before starting reconciliation', async () => {
    rows = [makeChannel({ type: 'wechat', config: { token_path: '', allowed_chat_ids: [] } })]
    await manager.start()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))

    qrOnConnect = 'https://example.com/qr'
    await expect(manager.waitForQrAndReconcile('agent-1', 'ch-1')).resolves.toBe('https://example.com/qr')
  })

  it('stop pauses intake, awaits drainTurns, then disconnects runtimes without releasing the hold itself', async () => {
    rows = [makeChannel()]
    await manager.start()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))
    const adapter = adapters[0]

    // Defer drainTurns so we can assert stop does not disconnect before the drain resolves.
    let releaseDrain!: () => void
    const drainPromise = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    vi.mocked(channelMessageHandler.drainTurns).mockReturnValue(drainPromise)

    const stopPromise = manager.stop()

    await vi.waitFor(() => expect(channelMessageHandler.acquireShutdownPause).toHaveBeenCalled())
    // start() already released its own (no-op) hold; stop must not release any hold itself.
    const releaseCountBeforeStop = vi.mocked(channelMessageHandler.releaseShutdownPause).mock.calls.length
    expect(adapter.disconnect).not.toHaveBeenCalled()

    releaseDrain()
    await stopPromise

    expect(adapter.disconnect).toHaveBeenCalled()
    expect(channelMessageHandler.clearSessionTrackerBindings).toHaveBeenCalled()
    // start() is responsible for releasing the hold, not stop().
    expect(vi.mocked(channelMessageHandler.releaseShutdownPause).mock.calls.length).toBe(releaseCountBeforeStop)
  })

  it('stop propagates a drainTurns timeout and blocks teardown (runtimes stay connected)', async () => {
    rows = [makeChannel()]
    await manager.start()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))
    const adapter = adapters[0]

    vi.mocked(channelMessageHandler.drainTurns).mockRejectedValue(new Error('drainTurns timed out after 50ms'))

    await expect(manager.stop()).rejects.toThrow(/timed out/)
    expect(adapter.disconnect).not.toHaveBeenCalled()
    // start() already released its own (no-op) hold; stop must not release any hold itself.
    const releaseCountBeforeStop = vi.mocked(channelMessageHandler.releaseShutdownPause).mock.calls.length
    expect(vi.mocked(channelMessageHandler.releaseShutdownPause).mock.calls.length).toBe(releaseCountBeforeStop)
  })

  it('start releases the shutdown pause hold left behind by stop', async () => {
    vi.mocked(channelMessageHandler.drainTurns).mockResolvedValue(undefined)
    await manager.stop()
    expect(channelMessageHandler.acquireShutdownPause).toHaveBeenCalled()
    expect(channelMessageHandler.releaseShutdownPause).not.toHaveBeenCalled()

    await manager.start()
    expect(channelMessageHandler.releaseShutdownPause).toHaveBeenCalledTimes(1)
  })
})
