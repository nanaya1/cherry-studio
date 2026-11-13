import { INDUSTRIAL_VIDEO_CHINESE_VOICES, INDUSTRIAL_VIDEO_ENGLISH_VOICES } from '@shared/data/industrialVideoVoices'

import { industrialVideoVoiceId } from './industrialVideoRequest'
import type { IndustrialVideoSettings } from './industrialVideoSettings'

// MEA:industrial-video 类型仅作选音提示，不改变服务端音色白名单或添加语音风格参数。
export const INDUSTRIAL_VIDEO_FEATURED_ENGLISH_VOICES = [
  { id: 'en-US-JennyNeural', key: 'en_general_female' },
  { id: 'en-US-AriaNeural', key: 'en_professional_female' },
  { id: 'en-US-GuyNeural', key: 'en_general_male' },
  { id: 'en-US-ChristopherNeural', key: 'en_deep_male' },
  { id: 'en-US-AnaNeural', key: 'en_child_female' }
] as const satisfies readonly { id: (typeof INDUSTRIAL_VIDEO_ENGLISH_VOICES)[number]['id']; key: string }[]

export function selectIndustrialVideoVoice(voice: string, language: string): IndustrialVideoSettings['voice'] {
  if (voice === '无旁白') return voice
  if (language === 'en-US') {
    return INDUSTRIAL_VIDEO_ENGLISH_VOICES.find((item) => item.id === voice)?.id ?? 'en-US-JennyNeural'
  }
  const id = industrialVideoVoiceId(voice as IndustrialVideoSettings['voice'])
  return (Object.entries(INDUSTRIAL_VIDEO_CHINESE_VOICES).find(
    ([label, value]) => label === voice || value === id
  )?.[0] ?? '沉稳男声') as IndustrialVideoSettings['voice']
}

export function resolveIndustrialVideoVoiceSettings(settings: IndustrialVideoSettings) {
  if (settings.voice === '无旁白') return { ttsEnabled: false, narrationFollowsSubtitles: true as const }
  return {
    voice: industrialVideoVoiceId(selectIndustrialVideoVoice(settings.voice, settings.subtitleLanguage)),
    ttsEnabled: true,
    narrationFollowsSubtitles: true as const
  }
}
