import { describe, expect, it } from 'vitest'

import {
  buildIndustrialVideoRequest,
  buildIndustrialVideoSettingsParams,
  industrialVideoVoiceId,
  INDUSTRIAL_VIDEO_VOICES
} from './industrialVideoRequest'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

describe('industrial video HTTP settings boundary', () => {
  it('maps product type, ratio and verified voice IDs without leaking unsupported settings', () => {
    const settings = createIndustrialVideoSettings('marketing')
    const request = buildIndustrialVideoRequest('run-a', settings)
    expect(request).toEqual({
      run: 'run-a',
      stage: 'video',
      style: 'marketing',
      aspect_ratio: '16:9',
      language: 'zh-CN',
      voice: 'zh-CN-YunjianNeural'
    })
    for (const field of ['duration', 'resolution', 'backgroundMusic', 'subtitle', 'with_audio', 'tts_enabled']) {
      expect(request).not.toHaveProperty(field)
    }
  })

  it('uses the explicitly agreed voice IDs for the six fixed neural voices', () => {
    const settings = createIndustrialVideoSettings('assembly')
    expect(INDUSTRIAL_VIDEO_VOICES['温柔女声']).toBe('zh-CN-XiaoxiaoNeural')
    expect(INDUSTRIAL_VIDEO_VOICES['知性女声']).toBe('zh-CN-XiaoyiNeural')
    expect(INDUSTRIAL_VIDEO_VOICES['阳光男声']).toBe('zh-CN-YunxiNeural')
    expect(INDUSTRIAL_VIDEO_VOICES['沉稳男声']).toBe('zh-CN-YunjianNeural')
    expect(INDUSTRIAL_VIDEO_VOICES['正式男声']).toBe('zh-CN-YunyangNeural')
    expect(INDUSTRIAL_VIDEO_VOICES['男孩童声']).toBe('zh-CN-YunxiaNeural')
    for (const voice of ['沉稳男声', '阳光男声', '正式男声'] as const) {
      expect(buildIndustrialVideoRequest('run-a', { ...settings, voice })).toMatchObject({
        style: 'training',
        voice: INDUSTRIAL_VIDEO_VOICES[voice]
      })
    }
  })

  it('refuses to misrepresent no narration by dropping voice or turning off native audio in the legacy API', () => {
    expect(() =>
      buildIndustrialVideoRequest('run-a', { ...createIndustrialVideoSettings('marketing'), voice: '无旁白' })
    ).toThrow('tts_switch_not_supported')
  })

  it('builds camelCase params with tts disabled for no narration and voice omitted', () => {
    const narrated = createIndustrialVideoSettings('marketing')
    expect(buildIndustrialVideoSettingsParams(narrated)).toEqual({
      targetDurationS: 30,
      resolution: '1080P',
      ttsEnabled: true,
      subtitleEnabled: true,
      backgroundMusicEnabled: true,
      withAudio: true,
      narrativeStyle: 'industrial',
      subtitleLanguage: 'zh-CN',
      bilingualSubtitles: false,
      secondSubtitleLanguage: 'en-US',
      narrationFollowsSubtitles: true
    })
    expect(industrialVideoVoiceId(narrated.voice)).toBe('zh-CN-YunjianNeural')

    const silent = { ...createIndustrialVideoSettings('assembly'), voice: '无旁白' as const }
    expect(buildIndustrialVideoSettingsParams(silent).ttsEnabled).toBe(false)
    expect(industrialVideoVoiceId(silent.voice)).toBeUndefined()
  })

  it('carries subtitle settings fields for subtitle sync (COWORK_HTTP_GUIDE §17)', () => {
    const settings = {
      ...createIndustrialVideoSettings('marketing'),
      subtitleLanguage: 'en-US' as const,
      bilingualSubtitles: true,
      secondSubtitleLanguage: 'ja-JP' as const
    }
    expect(buildIndustrialVideoSettingsParams(settings)).toMatchObject({
      subtitleEnabled: true,
      subtitleLanguage: 'en-US',
      bilingualSubtitles: true,
      secondSubtitleLanguage: 'ja-JP',
      narrationFollowsSubtitles: true
    })
  })

  it('attaches expectedSettingsVersion only when a known server version is supplied', () => {
    const settings = createIndustrialVideoSettings('marketing')
    expect(buildIndustrialVideoSettingsParams(settings, 3)).toMatchObject({ expectedSettingsVersion: 3 })
    expect(buildIndustrialVideoSettingsParams(settings)).not.toHaveProperty('expectedSettingsVersion')
    expect(buildIndustrialVideoSettingsParams(settings, null)).not.toHaveProperty('expectedSettingsVersion')
  })
})
