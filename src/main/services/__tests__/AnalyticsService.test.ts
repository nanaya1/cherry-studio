import { BaseService } from '@main/core/lifecycle'
import { LATEST_PRIVACY_POLICY_VERSION } from '@shared/utils/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Mea Cowork 关闭 Cherry 厂商遥测（analytics.cherry-ai.com）后的契约：
 * 无论隐私偏好如何变化，服务都不得激活、不得创建 AnalyticsClient、不得上报数据。
 * 原「按偏好激活 / 收敛 / token 上报」行为见 git 历史。
 */

const { mockTrackAppLaunch, mockTrackTokenUsage, mockTrackAppUpdate, mockDestroy, MockAnalyticsClient, captured } =
  vi.hoisted(() => {
    const trackAppLaunch = vi.fn()
    const trackTokenUsage = vi.fn()
    const trackAppUpdate = vi.fn()
    const destroy = vi.fn()
    return {
      mockTrackAppLaunch: trackAppLaunch,
      mockTrackTokenUsage: trackTokenUsage,
      mockTrackAppUpdate: trackAppUpdate,
      mockDestroy: destroy,
      MockAnalyticsClient: vi.fn(() => ({
        trackAppLaunch,
        trackTokenUsage,
        trackAppUpdate,
        destroy
      })),
      captured: {
        prefHandlers: {} as Record<string, (value: never) => void>,
        preferenceValues: {} as Record<string, boolean | string>
      }
    }
  })

vi.mock('@cherrystudio/analytics-client', () => ({
  AnalyticsClient: MockAnalyticsClient
}))

vi.mock('@main/utils/systemInfo', () => ({
  getClientId: vi.fn(() => 'test-client-id'),
  generateUserAgent: vi.fn(() => 'test-user-agent')
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    PreferenceService: {
      subscribeChange: vi.fn((key: string, cb: (value: never) => void) => {
        captured.prefHandlers[key] = cb
        return () => {}
      }),
      get: vi.fn((key: string) => captured.preferenceValues[key])
    }
  })
})

import { AnalyticsService } from '../AnalyticsService'

function changePreference(key: string, value: boolean | string): void {
  captured.preferenceValues[key] = value
  captured.prefHandlers[key]?.(value as never)
}

beforeEach(() => {
  BaseService.resetInstances()
  for (const key of Object.keys(captured.prefHandlers)) {
    delete captured.prefHandlers[key]
  }
  captured.preferenceValues['app.privacy.data_collection.enabled'] = true
  captured.preferenceValues['app.privacy.policy_version'] = LATEST_PRIVACY_POLICY_VERSION
  mockTrackAppLaunch.mockReset()
  mockTrackTokenUsage.mockReset()
  mockTrackAppUpdate.mockReset()
  mockDestroy.mockReset()
  MockAnalyticsClient.mockClear()
})

describe('AnalyticsService data collection preference', () => {
  it('stays inactive even after the latest privacy policy is accepted', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    expect(service.isActivated).toBe(false)
    expect(MockAnalyticsClient).not.toHaveBeenCalled()
    expect(captured.prefHandlers['app.privacy.policy_version']).toBeDefined()

    await service.trackAppUpdate()
    expect(mockTrackAppUpdate).not.toHaveBeenCalled()
  })

  it('stays inactive when the policy version changes at runtime', async () => {
    captured.preferenceValues['app.privacy.policy_version'] = ''
    const service = new AnalyticsService()
    await service._doInit()

    changePreference('app.privacy.policy_version', LATEST_PRIVACY_POLICY_VERSION)

    await service.trackAppUpdate()
    expect(service.isActivated).toBe(false)
    expect(MockAnalyticsClient).not.toHaveBeenCalled()
    expect(mockTrackAppLaunch).not.toHaveBeenCalled()
  })

  it('does not activate when data collection is toggled', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    changePreference('app.privacy.data_collection.enabled', false)
    changePreference('app.privacy.data_collection.enabled', true)

    expect(service.isActivated).toBe(false)
    expect(MockAnalyticsClient).not.toHaveBeenCalled()
    expect(mockDestroy).not.toHaveBeenCalled()
  })

  it('never re-activates across preference churn', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    changePreference('app.privacy.data_collection.enabled', false)
    changePreference('app.privacy.data_collection.enabled', true)
    changePreference('app.privacy.data_collection.enabled', false)

    expect(service.isActivated).toBe(false)
    expect(MockAnalyticsClient).not.toHaveBeenCalled()
  })
})

describe('AnalyticsService token usage', () => {
  it('does not forward usage while telemetry is disabled', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    service.trackTokenUsage({
      provider: 'test-provider',
      model: 'test-model',
      input_tokens: 3,
      output_tokens: 5,
      source: 'agent'
    })

    expect(mockTrackTokenUsage).not.toHaveBeenCalled()
  })

  it('does not forward embedding usage', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    service.trackTokenUsage({
      provider: 'test-provider',
      model: 'test-embedding-model',
      input_tokens: 42,
      output_tokens: 0,
      source: 'chat'
    })

    expect(mockTrackTokenUsage).not.toHaveBeenCalled()
  })

  it('does not forward usage when all token counts are zero', async () => {
    const service = new AnalyticsService()
    await service._doInit()

    service.trackTokenUsage({
      provider: 'test-provider',
      model: 'test-model',
      input_tokens: 0,
      output_tokens: 0,
      source: 'agent'
    })

    expect(mockTrackTokenUsage).not.toHaveBeenCalled()
  })
})
