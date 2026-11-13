import { describe, expect, it } from 'vitest'

import {
  buildIndustrialVideoPlanningKey,
  createIndustrialVideoSettings,
  normalizeIndustrialVideoSettings,
  normalizeIndustrialVideoVoice,
  validateIndustrialVideoInput
} from './industrialVideoSettings'

describe('industrial video input contract', () => {
  it('keeps distinct prototype defaults without sharing mutable settings', () => {
    const marketing = createIndustrialVideoSettings('marketing')
    const assembly = createIndustrialVideoSettings('assembly')
    expect(marketing).toMatchObject({
      duration: 30,
      ratio: '16:9',
      resolution: '1080P',
      style: '工业质感',
      voice: '沉稳男声',
      backgroundMusic: true,
      subtitle: true,
      withAudio: true
    })
    expect(assembly).toMatchObject({ style: '工业写实', voice: '沉稳男声', backgroundMusic: false, withAudio: true })
    marketing.duration = 90
    expect(createIndustrialVideoSettings('marketing').duration).toBe(30)
  })

  it('requires a nonblank request but allows creating without source files', () => {
    expect(validateIndustrialVideoInput({ request: '  ', sourceCount: 1, duration: 30 })).toBe('request-required')
    expect(validateIndustrialVideoInput({ request: '介绍设备', sourceCount: 0, duration: 30 })).toBeNull()
    expect(validateIndustrialVideoInput({ request: '介绍设备', sourceCount: 1, duration: 30 })).toBeNull()
  })

  it('allows 600 seconds and rejects invalid durations rather than silently changing the request', () => {
    expect(validateIndustrialVideoInput({ request: '介绍设备', sourceCount: 1, duration: 600 })).toBeNull()
    for (const duration of [0, -1, 0.5, 601, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateIndustrialVideoInput({ request: '介绍设备', sourceCount: 1, duration })).toBe('invalid-duration')
    }
  })

  it.each(['温柔女声', '知性女声'])('保留六款中文标签中的缓存音色 %s', (voice) => {
    expect(normalizeIndustrialVideoSettings({ voice }).voice).toBe(voice)
  })

  it('maps legacy cached voices to current equivalents instead of undefined', () => {
    expect(normalizeIndustrialVideoVoice('清晰女声')).toBe('温柔女声')
    expect(normalizeIndustrialVideoVoice('自然中性声')).toBe('沉稳男声')
    expect(normalizeIndustrialVideoVoice('阳光男声')).toBe('阳光男声')
    expect(normalizeIndustrialVideoVoice('无旁白')).toBe('无旁白')
    expect(normalizeIndustrialVideoVoice('未知音色')).toBe('沉稳男声')
    expect(normalizeIndustrialVideoVoice(undefined)).toBe('沉稳男声')
  })

  it('clamps unknown cached settings to valid values and keeps withAudio default true', () => {
    const normalized = normalizeIndustrialVideoSettings({
      type: 'assembly',
      duration: 9999,
      voice: '清晰女声'
      // 缺少 ratio / resolution / style / backgroundMusic / subtitle / withAudio
    })
    expect(normalized.duration).toBe(30)
    expect(normalized.voice).toBe('温柔女声')
    expect(normalized.withAudio).toBe(true)
    expect(normalized.ratio).toBe('16:9')
  })

  it('plans a new run only on type/duration/ratio/style changes, not resolution or audio toggles', () => {
    const base = createIndustrialVideoSettings('marketing')
    expect(buildIndustrialVideoPlanningKey(base)).toBe(
      buildIndustrialVideoPlanningKey({ ...base, resolution: '720P', backgroundMusic: false, withAudio: false })
    )
    expect(buildIndustrialVideoPlanningKey(base)).not.toBe(buildIndustrialVideoPlanningKey({ ...base, duration: 60 }))
    expect(buildIndustrialVideoPlanningKey(base)).not.toBe(buildIndustrialVideoPlanningKey({ ...base, ratio: '9:16' }))
  })
})
