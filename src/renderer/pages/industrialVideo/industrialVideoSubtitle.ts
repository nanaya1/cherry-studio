import type { IndustrialVideoSettings, IndustrialVideoSubtitleLanguage } from './industrialVideoSettings'

/**
 * 工业视频字幕配置的小型纯逻辑 helper（不依赖 React / IPC）。
 *
 * 关注点：把客户端设置裁剪为字幕相关 wire 字段、计算“仅被主动修改”的 patch、
 * 识别主语言变更、以及解释 video_start 回执里的冲突/重规划信号。IPC 调用与
 * 版本冲突处理在调用方（industrialVideoWorkflow）完成，本文件只负责可单测的判定。
 */

export type SubtitleSettingField =
  | 'subtitleEnabled'
  | 'subtitleLanguage'
  | 'bilingualSubtitles'
  | 'secondSubtitleLanguage'
  | 'narrationFollowsSubtitles'

export const SUBTITLE_SETTING_FIELDS: readonly SubtitleSettingField[] = [
  'subtitleEnabled',
  'subtitleLanguage',
  'bilingualSubtitles',
  'secondSubtitleLanguage',
  'narrationFollowsSubtitles'
] as const

/** 字幕语言下拉选项（wire 值 + i18n key），顺序即展示顺序。 */
export const INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS: ReadonlyArray<{
  code: IndustrialVideoSubtitleLanguage
  labelKey: string
}> = [
  { code: 'zh-CN', labelKey: 'industrial_video.language.zh_cn' },
  { code: 'en-US', labelKey: 'industrial_video.language.en_us' }
]

/** 客户端设置 -> 字幕相关 wire 字段（字幕开关映射为 `subtitleEnabled`）。 */
export function buildSubtitleSettingsParams(settings: IndustrialVideoSettings) {
  return {
    subtitleEnabled: settings.subtitle,
    subtitleLanguage: settings.subtitleLanguage,
    bilingualSubtitles: settings.bilingualSubtitles,
    secondSubtitleLanguage: settings.secondSubtitleLanguage,
    // narrationFollowsSubtitles: settings.narrationFollowsSubtitles
    narrationFollowsSubtitles: true
  }
}

/** 从服务端 `effective_settings` 记录里提取已同步的字幕字段快照（仅取已知 camelCase 键）。 */
export function extractSubtitleServerSnapshot(
  effectiveSettings: Record<string, unknown> | null | undefined
): Partial<Record<SubtitleSettingField, unknown>> {
  const source = effectiveSettings ?? {}
  const snapshot: Partial<Record<SubtitleSettingField, unknown>> = {}
  for (const field of SUBTITLE_SETTING_FIELDS) {
    const wireKey = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    if (wireKey in source) snapshot[field] = source[wireKey]
    else if (field in source) snapshot[field] = source[field]
  }
  return snapshot
}

/**
 * 比较本地设置与“上次服务端同步快照”，仅返回被主动修改过的字幕字段（patch 用）。
 * 快照中缺失的字段视为尚未同步，会被一并输出（首次同步场景）。
 */
export function diffSubtitleSettings(
  local: IndustrialVideoSettings,
  serverSnapshot: Partial<Record<SubtitleSettingField, unknown>>
): Partial<ReturnType<typeof buildSubtitleSettingsParams>> {
  const localParams = buildSubtitleSettingsParams(local)
  const patch: Record<string, unknown> = {}
  for (const field of SUBTITLE_SETTING_FIELDS) {
    if (!Object.is(localParams[field], serverSnapshot[field])) {
      patch[field] = localParams[field]
    }
  }
  return patch
}

/** 主字幕语言是否发生变化（“主语言变更”需模型重新规划与网页审核）。 */
export function isMainSubtitleLanguageChange(
  local: IndustrialVideoSettings,
  serverSnapshot: Partial<Record<SubtitleSettingField, unknown>>
): boolean {
  return local.subtitleLanguage !== serverSnapshot.subtitleLanguage
}

/** 主语言与第二语言相同属于非法组合，调用方应在提交前拦截。 */
export function hasDuplicateSubtitleLanguages(settings: IndustrialVideoSettings): boolean {
  return settings.bilingualSubtitles && settings.subtitleLanguage === settings.secondSubtitleLanguage
}

/** 服务端对版本冲突使用的错误标记（与 main 端约定，协调后由 main 返回）。 */
export const SETTINGS_VERSION_CONFLICT_CODE = 'settings_version_conflict'

/** 判断错误是否为设置版本冲突（应停止本轮、不静默覆盖）。 */
export function isSettingsVersionConflict(error: unknown): boolean {
  const err = error as { data?: { code?: unknown }; message?: string } | null
  if (err && typeof err.data?.code === 'string' && err.data.code === SETTINGS_VERSION_CONFLICT_CODE) return true
  const message = typeof err?.message === 'string' ? err.message : ''
  return message.includes('设置版本冲突') || message.toLowerCase().includes('settings version conflict')
}

export interface SubtitleSyncReceipt {
  /** 服务端接受了本次字幕字段变更。 */
  settingsChanged: boolean
  /** 主语言变更或回执显式要求：后续需模型重新规划与网页审核。 */
  requiresReplan: boolean
  /** 服务端已持久化设置。 */
  settingsPersisted: boolean
  /** 服务端当前设置版本；null 表示回执未给出。 */
  settingsVersion: number | null
}

/** 解释 video_start 回执（成功路径）；冲突由调用方捕获 IpcError 处理，不在此覆盖。 */
export function interpretSubtitleSyncReceipt(receipt: Record<string, unknown> | null | undefined): SubtitleSyncReceipt {
  const data = receipt ?? {}
  const settingsVersion = typeof data.settingsVersion === 'number' ? data.settingsVersion : null
  return {
    settingsChanged: Boolean(data.settingsChanged),
    requiresReplan: Boolean(data.requiresReplan),
    settingsPersisted: data.settingsPersisted !== false,
    settingsVersion
  }
}
