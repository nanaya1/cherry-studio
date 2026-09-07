import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  ensureValidApiKey: vi.fn(),
  getAgentSessionUsageHeaders: vi.fn(),
  getCurrentConfig: vi.fn(),
  getInternalRequestToken: vi.fn(),
  isRunning: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'ApiGatewayService') {
        return {
          ensureRunning: mocks.ensureRunning,
          ensureValidApiKey: mocks.ensureValidApiKey,
          getAgentSessionUsageHeaders: mocks.getAgentSessionUsageHeaders,
          getCurrentConfig: mocks.getCurrentConfig,
          getInternalRequestToken: mocks.getInternalRequestToken,
          isRunning: mocks.isRunning
        }
      }
      throw new Error(`unexpected service ${name}`)
    }
  }
}))

import {
  ApiGatewayNotRunningError,
  gatewayCredentialsFingerprint,
  resolveApiGatewayRuntime
} from '../agentApiGateway'

describe('gatewayCredentialsFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentConfig.mockReturnValue({ enabled: true, host: '127.0.0.1', port: 23333, apiKey: 'gw-key-1' })
    mocks.isRunning.mockReturnValue(true)
  })

  it('changes when the gateway key rotates', () => {
    const before = gatewayCredentialsFingerprint()
    mocks.getCurrentConfig.mockReturnValue({ enabled: true, host: '127.0.0.1', port: 23333, apiKey: 'gw-key-2' })
    expect(gatewayCredentialsFingerprint()).not.toBe(before)
  })

  it('changes when the gateway address or enabled/running state changes', () => {
    const before = gatewayCredentialsFingerprint()
    mocks.getCurrentConfig.mockReturnValue({ enabled: true, host: '127.0.0.2', port: 24444, apiKey: 'gw-key-1' })
    expect(gatewayCredentialsFingerprint()).not.toBe(before)

    mocks.getCurrentConfig.mockReturnValue({ enabled: true, host: '127.0.0.1', port: 23333, apiKey: 'gw-key-1' })
    mocks.isRunning.mockReturnValue(false)
    expect(gatewayCredentialsFingerprint()).not.toBe(before)
  })

  it('is stable across reads with unchanged state and never leaks the key', () => {
    const first = gatewayCredentialsFingerprint()
    expect(gatewayCredentialsFingerprint()).toBe(first)
    expect(first).not.toContain('gw-key-1')
  })
})

describe('resolveApiGatewayRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentConfig.mockReturnValue({ enabled: null, host: '127.0.0.1', port: 23333, apiKey: null })
    mocks.isRunning.mockReturnValue(false)
    mocks.ensureRunning.mockResolvedValue(undefined)
    mocks.ensureValidApiKey.mockResolvedValue('generated-key')
    mocks.getAgentSessionUsageHeaders.mockReturnValue({ 'x-session': 'session-1' })
    mocks.getInternalRequestToken.mockReturnValue('internal-token')
  })

  it('starts the gateway on demand when intent is automatic', async () => {
    await expect(resolveApiGatewayRuntime('session-1')).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:23333',
      apiKey: 'generated-key',
      usageHeaders: { 'x-session': 'session-1' },
      internalRequestToken: 'internal-token'
    })

    expect(mocks.ensureRunning).toHaveBeenCalledOnce()
    expect(mocks.ensureValidApiKey).toHaveBeenCalledOnce()
  })

  it('does not start the gateway after the user explicitly disabled it', async () => {
    mocks.getCurrentConfig.mockReturnValue({ enabled: false, host: '127.0.0.1', port: 23333, apiKey: null })

    await expect(resolveApiGatewayRuntime('session-1')).rejects.toBeInstanceOf(ApiGatewayNotRunningError)
    expect(mocks.ensureRunning).not.toHaveBeenCalled()
    expect(mocks.ensureValidApiKey).not.toHaveBeenCalled()
  })
})
