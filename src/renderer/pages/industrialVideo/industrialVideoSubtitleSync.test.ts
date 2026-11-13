import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { createIndustrialVideoSettings } from './industrialVideoSettings'
import { syncIndustrialVideoSubtitleSettings } from './industrialVideoWorkflow'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }
}))

const request = vi.mocked(ipcApi.request)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syncIndustrialVideoSubtitleSettings', () => {
  it('never overwrites webpage settings when no subtitle control was edited', async () => {
    request.mockResolvedValue({ effective_settings: { settings_version: 7, subtitle_language: 'ja-JP' } })
    await syncIndustrialVideoSubtitleSettings('s1', 'run1', createIndustrialVideoSettings('marketing'), [])
    expect(request.mock.calls.map(([channel]) => channel)).toEqual(['industrial_video.planning_context_get'])
  })

  it('reads planning context and skips video_start when nothing changed (no overwrite)', async () => {
    const settings = createIndustrialVideoSettings('marketing')
    const params = {
      subtitleEnabled: true,
      subtitleLanguage: 'zh-CN' as const,
      bilingualSubtitles: false,
      secondSubtitleLanguage: 'en-US' as const,
      narrationFollowsSubtitles: true
    }
    request.mockImplementation(async (channel) => {
      if (channel === 'industrial_video.planning_context_get') {
        return { settings_version: 2, effective_settings: params } as never
      }
      throw new Error(`Unexpected ${channel}`)
    })
    const receipt = await syncIndustrialVideoSubtitleSettings('s1', 'run1', settings)
    expect(receipt.settingsChanged).toBe(false)
    expect(request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything(), expect.anything())
  })

  it('patches only changed subtitle fields with expectedSettingsVersion on change', async () => {
    const settings = { ...createIndustrialVideoSettings('marketing'), subtitleLanguage: 'en-US' as const }
    request.mockImplementation(async (channel) => {
      if (channel === 'industrial_video.planning_context_get') {
        return {
          settings_version: 3,
          effective_settings: {
            subtitleEnabled: true,
            subtitleLanguage: 'zh-CN',
            bilingualSubtitles: false,
            secondSubtitleLanguage: 'en-US',
            narrationFollowsSubtitles: true
          }
        } as never
      }
      if (channel === 'industrial_video.video_start') {
        return { settingsChanged: true, requiresReplan: true, settingsVersion: 3 } as never
      }
      throw new Error(`Unexpected ${channel}`)
    })
    const receipt = await syncIndustrialVideoSubtitleSettings('s1', 'run1', settings)
    expect(receipt.requiresReplan).toBe(true)
    expect(request).toHaveBeenCalledWith('industrial_video.video_start', {
      sessionId: 's1',
      run: 'run1',
      stage: 'plan',
      subtitleLanguage: 'en-US',
      voice: 'en-US-JennyNeural',
      ttsEnabled: true,
      narrationFollowsSubtitles: true,
      expectedSettingsVersion: 3
    })
  })

  it('rethrows a settings version conflict to stop the round (no silent overwrite)', async () => {
    const settings = { ...createIndustrialVideoSettings('marketing'), subtitleLanguage: 'en-US' as const }
    request.mockImplementation(async (channel) => {
      if (channel === 'industrial_video.planning_context_get') {
        return { settings_version: 5, effective_settings: { subtitleLanguage: 'zh-CN' } } as never
      }
      if (channel === 'industrial_video.video_start') {
        throw Object.assign(new Error('设置版本冲突，拒绝覆盖'), { data: { code: 'settings_version_conflict' } })
      }
      throw new Error(`Unexpected ${channel}`)
    })
    await expect(syncIndustrialVideoSubtitleSettings('s1', 'run1', settings)).rejects.toThrow(/设置版本冲突/)
  })

  it('stops the round on any settings sync failure', async () => {
    const settings = { ...createIndustrialVideoSettings('marketing'), subtitleLanguage: 'en-US' as const }
    request.mockImplementation(async (channel) => {
      if (channel === 'industrial_video.planning_context_get') {
        return { settings_version: 1, effective_settings: { subtitleLanguage: 'zh-CN' } } as never
      }
      if (channel === 'industrial_video.video_start') {
        throw new Error('field not supported yet')
      }
      throw new Error(`Unexpected ${channel}`)
    })
    await expect(syncIndustrialVideoSubtitleSettings('s1', 'run1', settings)).rejects.toThrow('field not supported yet')
  })
})
