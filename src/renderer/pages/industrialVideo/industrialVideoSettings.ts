import type { IndustrialVideoSubtitleLanguage } from '@shared/data/cache/cacheValueTypes'
import { INDUSTRIAL_VIDEO_VOICE_IDS, type IndustrialVideoVoiceId, type INDUSTRIAL_VIDEO_CHINESE_VOICES } from '@shared/data/industrialVideoVoices'

import { INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES } from '@shared/data/cache/cacheValueTypes'

export const MAX_DURATION_SECONDS = 600

export type IndustrialVideoType = 'marketing' | 'assembly'

export type { IndustrialVideoSubtitleLanguage }

/** 字幕语言白名单（与 shared `INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES` 同源）。 */
export const INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGES = INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES

/**
 * 六款固定音色 + 无旁白。音色展示名为产品名，提交时由 `industrialVideoRequest`
 * 映射为服务端 `voice` ID（见 COWORK_HTTP_GUIDE §17.1）。`无旁白` 不是音色，而是
 * `ttsEnabled=false` 的语义，不映射任何 `voice` ID。
 */
// export type IndustrialVideoVoice =
//   | '温柔女声' | '知性女声' | '阳光男声' | '沉稳男声' | '正式男声' | '男孩童声' | '无旁白'
export type IndustrialVideoVoice = keyof typeof INDUSTRIAL_VIDEO_CHINESE_VOICES | IndustrialVideoVoiceId | '无旁白'

export interface IndustrialVideoSettings {
  type: IndustrialVideoType
  duration: number
  ratio: '16:9' | '9:16' | '1:1'
  resolution: '720P' | '1080P'
  style: '工业质感' | '工业写实' | '科技' | '现代' | '武侠' | '古风'
  voice: IndustrialVideoVoice
  backgroundMusic: boolean
  subtitle: boolean
  /** 视频生成模型是否保留原生音轨，独立于 TTS 与背景音乐（COWORK_HTTP_GUIDE §17）。 */
  withAudio: boolean
  /** 主字幕语言；默认中文。变更视为“主语言变更”，需模型重新规划与网页审核。 */
  subtitleLanguage: IndustrialVideoSubtitleLanguage
  /** 是否生成双语字幕（主语言 + 第二语言）。 */
  bilingualSubtitles: boolean
  /** 第二字幕语言；仅 bilingualSubtitles=true 时生效，且不得等于 subtitleLanguage。 */
  secondSubtitleLanguage: IndustrialVideoSubtitleLanguage
  /** 旁白跟随字幕语言，固定 true（服务端约束），客户端不可改为 false。 */
  narrationFollowsSubtitles: boolean
}

export function createIndustrialVideoSettings(type: IndustrialVideoType): IndustrialVideoSettings {
  return {
    type,
    duration: 30,
    ratio: '16:9',
    resolution: '1080P',
    style: type === 'marketing' ? '工业质感' : '工业写实',
    // voice: type === 'marketing' ? '温柔女声' : '沉稳男声',
    voice: '沉稳男声',
    backgroundMusic: type === 'marketing',
    subtitle: true,
    withAudio: true,
    subtitleLanguage: 'zh-CN',
    bilingualSubtitles: false,
    secondSubtitleLanguage: 'en-US',
    narrationFollowsSubtitles: true
  }
}

export function validateIndustrialVideoInput(input: {
  request: string
  sourceCount: number
  duration: number
}): 'request-required' | 'source-required' | 'invalid-duration' | null {
  if (!input.request.trim()) return 'request-required'
  // 资料是可选项：没有上传本地文件或选择知识库文件时，也允许仅根据需求制作视频。
  // if (input.sourceCount < 1) return 'source-required'
  if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > MAX_DURATION_SECONDS) {
    return 'invalid-duration'
  }
  return null
}

const ALL_VOICES: readonly IndustrialVideoVoice[] = [
  '温柔女声',
  '知性女声',
  '阳光男声',
  '沉稳男声',
  '正式男声',
  '男孩童声',
  '无旁白'
]

/**
 * 旧缓存兼容：早期原型使用 `清晰女声` / `自然中性声`，其音色 ID 已被六款固定音色取代。
 * 老记录读到未知或暂不可用音色时不要变成 `undefined`，缺省回退到沉稳男声。
 */
const LEGACY_VOICE_COMPAT: Record<string, IndustrialVideoVoice> = {
  清晰女声: '温柔女声',
  自然中性声: '沉稳男声'
}

export function normalizeIndustrialVideoVoice(value: unknown): IndustrialVideoVoice {
  // if (value === '温柔女声' || value === '知性女声' || value === '清晰女声') return '沉稳男声'
  if (INDUSTRIAL_VIDEO_VOICE_IDS.includes(value as IndustrialVideoVoiceId)) return value as IndustrialVideoVoiceId
  if (typeof value === 'string' && (ALL_VOICES as readonly string[]).includes(value)) {
    return value as IndustrialVideoVoice
  }
  if (typeof value === 'string' && value in LEGACY_VOICE_COMPAT) {
    return LEGACY_VOICE_COMPAT[value]
  }
  // return '温柔女声'
  return '沉稳男声'
}

const RATIOS = ['16:9', '9:16', '1:1'] as const
const RESOLUTIONS = ['720P', '1080P'] as const
const STYLES = ['工业质感', '工业写实', '科技', '现代', '武侠', '古风'] as const

/** 把未知来源（本地缓存草稿）的对象夹紧为合法设置，避免老记录字段缺失或越界。 */
export function normalizeIndustrialVideoSettings(value: unknown): IndustrialVideoSettings {
  const fallback = createIndustrialVideoSettings('marketing')
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Record<string, unknown>
  const type: IndustrialVideoType = raw.type === 'assembly' ? 'assembly' : 'marketing'
  const defaults = createIndustrialVideoSettings(type)
  const duration =
    typeof raw.duration === 'number' &&
    Number.isInteger(raw.duration) &&
    raw.duration >= 1 &&
    raw.duration <= MAX_DURATION_SECONDS
      ? raw.duration
      : defaults.duration
  return {
    type,
    duration,
    ratio: RATIOS.includes(raw.ratio as (typeof RATIOS)[number])
      ? (raw.ratio as IndustrialVideoSettings['ratio'])
      : defaults.ratio,
    resolution: RESOLUTIONS.includes(raw.resolution as (typeof RESOLUTIONS)[number])
      ? (raw.resolution as IndustrialVideoSettings['resolution'])
      : defaults.resolution,
    style: STYLES.includes(raw.style as (typeof STYLES)[number])
      ? (raw.style as IndustrialVideoSettings['style'])
      : defaults.style,
    voice: normalizeIndustrialVideoVoice(raw.voice),
    backgroundMusic: typeof raw.backgroundMusic === 'boolean' ? raw.backgroundMusic : defaults.backgroundMusic,
    subtitle: typeof raw.subtitle === 'boolean' ? raw.subtitle : defaults.subtitle,
    // 旧缓存没有 withAudio 字段时回退到默认（true），不静默改为 false。
    withAudio: typeof raw.withAudio === 'boolean' ? raw.withAudio : defaults.withAudio,
    // 字幕语言：旧缓存缺字段或非法码时回退默认语言，不把未知串当合法值。
    subtitleLanguage: INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES.includes(
      raw.subtitleLanguage as IndustrialVideoSubtitleLanguage
    )
      ? (raw.subtitleLanguage as IndustrialVideoSubtitleLanguage)
      : defaults.subtitleLanguage,
    bilingualSubtitles: typeof raw.bilingualSubtitles === 'boolean' ? raw.bilingualSubtitles : defaults.bilingualSubtitles,
    // 第二语言同样夹紧；若与主语言相同（旧缓存/异常），回退默认第二语言，避免同语。
    secondSubtitleLanguage:
      INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES.includes(raw.secondSubtitleLanguage as IndustrialVideoSubtitleLanguage) &&
      raw.secondSubtitleLanguage !== raw.subtitleLanguage
        ? (raw.secondSubtitleLanguage as IndustrialVideoSubtitleLanguage)
        : defaults.secondSubtitleLanguage,
    // narrationFollowsSubtitles 服务端固定 true：旧缓存无论写入何值都归一为 true，绝不静默改为 false。
    narrationFollowsSubtitles: true
  }
}

/**
 * 规划 key：只含会触发“新 run”的产品规划维度（类型、时长、画幅、风格）。
 * 分辨率按文档归为输出/混音设置，不计入规划 key，避免把确认过的新 run 误判为变化。
 */
export function buildIndustrialVideoPlanningKey(settings: IndustrialVideoSettings): string {
  return JSON.stringify({
    type: settings.type,
    duration: settings.duration,
    ratio: settings.ratio,
    style: settings.style
  })
}
