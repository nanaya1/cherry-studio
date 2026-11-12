import type { IndustrialVideoSettings, IndustrialVideoVoice } from './industrialVideoSettings'

export const INDUSTRIAL_VIDEO_VOICES = {
  温柔女声: 'zh-CN-XiaoxiaoNeural',
  知性女声: 'zh-CN-XiaoyiNeural',
  阳光男声: 'zh-CN-YunxiNeural',
  沉稳男声: 'zh-CN-YunjianNeural',
  正式男声: 'zh-CN-YunyangNeural',
  男孩童声: 'zh-CN-YunxiaNeural'
} as const

/** 把展示音色映射为服务端 `voice` ID；`无旁白` 不传 voice（由 `ttsEnabled=false` 表达）。 */
export function industrialVideoVoiceId(voice: IndustrialVideoVoice) {
  return voice === '无旁白' ? undefined : INDUSTRIAL_VIDEO_VOICES[voice]
}

export const INDUSTRIAL_VIDEO_NARRATIVE_STYLES = {
  工业质感: 'industrial',
  工业写实: 'industrial',
  科技: 'technology',
  现代: 'modern',
  武侠: 'wuxia',
  古风: 'historical'
} as const

/**
 * 旧 snake_case 兼容入口：仅映射产品类型/画幅/音色，不允许携带时长、分辨率、字幕、
 * 音乐或 `with_audio`，也不能用省略 `voice` 冒充无旁白。新流程请改用
 * `buildIndustrialVideoSettingsParams` + `industrialVideoVoiceId`。
 */
export function buildIndustrialVideoRequest(run: string, settings: IndustrialVideoSettings) {
  if (settings.voice === '无旁白') throw new Error('tts_switch_not_supported')
  return {
    run,
    stage: 'video' as const,
    style: settings.type === 'marketing' ? ('marketing' as const) : ('training' as const),
    aspect_ratio: settings.ratio,
    language: 'zh-CN',
    voice: INDUSTRIAL_VIDEO_VOICES[settings.voice]
  }
}

export interface IndustrialVideoSettingsParams {
  targetDurationS: number
  resolution: '720P' | '1080P'
  ttsEnabled: boolean
  subtitleEnabled: boolean
  backgroundMusicEnabled: boolean
  withAudio: boolean
  narrativeStyle: (typeof INDUSTRIAL_VIDEO_NARRATIVE_STYLES)[IndustrialVideoSettings['style']]
  expectedSettingsVersion?: number
}

/**
 * 把客户端设置转换为 `parse` / `video_start` 共用的最新 camelCase 入参
 * （COWORK_HTTP_GUIDE §17）。`无旁白` 映射为 `ttsEnabled=false` 且不传 `voice`。
 * `expectedSettingsVersion` 由调用方在已知服务端设置版本时传入，用于阻止版本漂移。
 */
export function buildIndustrialVideoSettingsParams(
  settings: IndustrialVideoSettings,
  expectedSettingsVersion?: number | null
): IndustrialVideoSettingsParams {
  const params: IndustrialVideoSettingsParams = {
    targetDurationS: settings.duration,
    resolution: settings.resolution,
    ttsEnabled: settings.voice !== '无旁白',
    subtitleEnabled: settings.subtitle,
    backgroundMusicEnabled: settings.backgroundMusic,
    withAudio: settings.withAudio,
    narrativeStyle: INDUSTRIAL_VIDEO_NARRATIVE_STYLES[settings.style]
  }
  if (typeof expectedSettingsVersion === 'number' && expectedSettingsVersion >= 0) {
    params.expectedSettingsVersion = expectedSettingsVersion
  }
  return params
}
