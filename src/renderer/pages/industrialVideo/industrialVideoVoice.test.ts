import { describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))

import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

import { industrialVideoVoiceId, buildIndustrialVideoSettingsParams } from './industrialVideoRequest'
import { createIndustrialVideoSettings, normalizeIndustrialVideoSettings } from './industrialVideoSettings'
import { INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS } from './industrialVideoSubtitle'
import { resolveIndustrialVideoVoiceSettings, selectIndustrialVideoVoice } from './industrialVideoVoice'

const englishIds = [
  'Ana',
  'AndrewMultilingual',
  'Andrew',
  'Aria',
  'AvaMultilingual',
  'Ava',
  'BrianMultilingual',
  'Brian',
  'Christopher',
  'EmmaMultilingual',
  'Emma',
  'Eric',
  'Guy',
  'Jenny',
  'Michelle',
  'Roger',
  'Steffan'
].map((name) => `en-US-${name}Neural`)

describe('工业视频静态音色契约', () => {
  it('仅开放中英文字幕选项', () => {
    expect(INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS.map((item) => item.code)).toEqual(['zh-CN', 'en-US'])
  })
  it('保留同语言选择与中文标签，纠正非当前语言音色，保留无旁白', () => {
    expect(selectIndustrialVideoVoice('沉稳男声', 'en-US')).toBe('en-US-JennyNeural')
    expect(selectIndustrialVideoVoice('en-US-GuyNeural', 'en-US')).toBe('en-US-GuyNeural')
    expect(selectIndustrialVideoVoice('温柔女声', 'zh-CN')).toBe('温柔女声')
    expect(selectIndustrialVideoVoice('en-US-GuyNeural', 'zh-CN')).toBe('沉稳男声')
    expect(selectIndustrialVideoVoice('无旁白', 'en-US')).toBe('无旁白')
  })
  it.each(englishIds)('固定英文 ID %s 穿过缓存、请求和 IPC', async (voice) => {
    const settings = normalizeIndustrialVideoSettings({
      ...createIndustrialVideoSettings('marketing'),
      voice,
      subtitleLanguage: 'en-US'
    })
    expect(settings.voice).toBe(voice)
    expect(industrialVideoVoiceId(settings.voice)).toBe(voice)
    expect(
      buildIndustrialVideoSettingsParams({ ...settings, narrationFollowsSubtitles: false }).narrationFollowsSubtitles
    ).toBe(true)
    for (const route of [
      'industrial_video.parse',
      'industrial_video.video_start',
      'industrial_video.estimate'
    ] as const) {
      expect(industrialVideoRequestSchemas[route].input.safeParse({ sessionId: 's', run: 'r', voice }).success).toBe(
        true
      )
      expect(
        industrialVideoRequestSchemas[route].input.safeParse({ sessionId: 's', run: 'r', voice: 'en-US-UnknownNeural' })
          .success
      ).toBe(false)
    }
    expect(resolveIndustrialVideoVoiceSettings(settings)).toEqual({
      voice,
      ttsEnabled: true,
      narrationFollowsSubtitles: true
    })
    expect(ipcApi.request).not.toHaveBeenCalled()
  })
  it('无音色查询 IPC，离线提交纠正旧音色且无旁白不传 voice', async () => {
    expect(industrialVideoRequestSchemas).not.toHaveProperty('industrial_video.tts_options_get')
    expect(
      resolveIndustrialVideoVoiceSettings({ ...createIndustrialVideoSettings('marketing'), subtitleLanguage: 'en-US' })
    ).toEqual({ voice: 'en-US-JennyNeural', ttsEnabled: true, narrationFollowsSubtitles: true })
    expect(
      resolveIndustrialVideoVoiceSettings({ ...createIndustrialVideoSettings('marketing'), voice: '无旁白' })
    ).toEqual({ ttsEnabled: false, narrationFollowsSubtitles: true })
    expect(ipcApi.request).not.toHaveBeenCalled()
  })
})
