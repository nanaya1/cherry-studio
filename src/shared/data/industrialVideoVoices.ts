// MEA:industrial-video 固定音色白名单；英语来自 edge-voices.json 的 en-US 全量17款。
export const INDUSTRIAL_VIDEO_ENGLISH_VOICES = [
  { id: 'en-US-AnaNeural', key: 'en_ana' },
  { id: 'en-US-AndrewMultilingualNeural', key: 'en_andrew_multilingual' },
  { id: 'en-US-AndrewNeural', key: 'en_andrew' },
  { id: 'en-US-AriaNeural', key: 'en_aria' },
  { id: 'en-US-AvaMultilingualNeural', key: 'en_ava_multilingual' },
  { id: 'en-US-AvaNeural', key: 'en_ava' },
  { id: 'en-US-BrianMultilingualNeural', key: 'en_brian_multilingual' },
  { id: 'en-US-BrianNeural', key: 'en_brian' },
  { id: 'en-US-ChristopherNeural', key: 'en_christopher' },
  { id: 'en-US-EmmaMultilingualNeural', key: 'en_emma_multilingual' },
  { id: 'en-US-EmmaNeural', key: 'en_emma' },
  { id: 'en-US-EricNeural', key: 'en_eric' },
  { id: 'en-US-GuyNeural', key: 'en_guy' },
  { id: 'en-US-JennyNeural', key: 'en_jenny' },
  { id: 'en-US-MichelleNeural', key: 'en_michelle' },
  { id: 'en-US-RogerNeural', key: 'en_roger' },
  { id: 'en-US-SteffanNeural', key: 'en_steffan' }
] as const

export const INDUSTRIAL_VIDEO_CHINESE_VOICES = {
  温柔女声: 'zh-CN-XiaoxiaoNeural',
  知性女声: 'zh-CN-XiaoyiNeural',
  阳光男声: 'zh-CN-YunxiNeural',
  沉稳男声: 'zh-CN-YunjianNeural',
  正式男声: 'zh-CN-YunyangNeural',
  男孩童声: 'zh-CN-YunxiaNeural'
} as const

export const INDUSTRIAL_VIDEO_VOICE_IDS = [
  ...Object.values(INDUSTRIAL_VIDEO_CHINESE_VOICES),
  ...INDUSTRIAL_VIDEO_ENGLISH_VOICES.map((voice) => voice.id)
] as const

export type IndustrialVideoVoiceId = (typeof INDUSTRIAL_VIDEO_VOICE_IDS)[number]
