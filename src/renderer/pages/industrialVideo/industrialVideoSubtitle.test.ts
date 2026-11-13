import { describe, expect, it } from 'vitest'

import { createIndustrialVideoSettings } from './industrialVideoSettings'
import {
  buildSubtitleSettingsParams,
  diffSubtitleSettings,
  extractSubtitleServerSnapshot,
  hasDuplicateSubtitleLanguages,
  interpretSubtitleSyncReceipt,
  isMainSubtitleLanguageChange,
  isSettingsVersionConflict,
  SETTINGS_VERSION_CONFLICT_CODE
} from './industrialVideoSubtitle'

describe('industrial video subtitle helper', () => {
  it('maps client settings to subtitle wire fields (subtitle -> subtitleEnabled)', () => {
    const settings = createIndustrialVideoSettings('marketing')
    expect(buildSubtitleSettingsParams(settings)).toEqual({
      subtitleEnabled: true,
      subtitleLanguage: 'zh-CN',
      bilingualSubtitles: false,
      secondSubtitleLanguage: 'en-US',
      narrationFollowsSubtitles: true
    })
  })

  it('extracts only known subtitle keys from an effective_settings record', () => {
    expect(
      extractSubtitleServerSnapshot({
        subtitleLanguage: 'en-US',
        unknown_field: 1,
        bilingualSubtitles: true
      })
    ).toEqual({ subtitleLanguage: 'en-US' as const, bilingualSubtitles: true })
    expect(extractSubtitleServerSnapshot(null)).toEqual({})
  })

  it('returns an empty patch when local matches the server snapshot (no overwrite)', () => {
    const local = createIndustrialVideoSettings('marketing')
    const server = buildSubtitleSettingsParams(local)
    expect(diffSubtitleSettings(local, server)).toEqual({})
  })

  it('patches only the actively modified subtitle fields against the server snapshot', () => {
    const local = {
      ...createIndustrialVideoSettings('marketing'),
      subtitleLanguage: 'en-US' as const,
      bilingualSubtitles: true
    }
    const server = {
      subtitleEnabled: true,
      subtitleLanguage: 'zh-CN',
      bilingualSubtitles: false,
      secondSubtitleLanguage: 'en-US',
      narrationFollowsSubtitles: true
    }
    expect(diffSubtitleSettings(local, server)).toEqual({
      subtitleLanguage: 'en-US',
      bilingualSubtitles: true
    })
  })

  it('detects a main subtitle language change (requires replan + web review)', () => {
    const local = { ...createIndustrialVideoSettings('marketing'), subtitleLanguage: 'ja-JP' as const }
    expect(isMainSubtitleLanguageChange(local, { subtitleLanguage: 'zh-CN' })).toBe(true)
    expect(isMainSubtitleLanguageChange(local, { subtitleLanguage: 'ja-JP' as const })).toBe(false)
  })

  it('flags duplicate main/second languages as invalid', () => {
    const ok = {
      ...createIndustrialVideoSettings('marketing'),
      bilingualSubtitles: true,
      secondSubtitleLanguage: 'en-US' as const
    }
    expect(hasDuplicateSubtitleLanguages(ok)).toBe(false)
    const bad = {
      ...createIndustrialVideoSettings('marketing'),
      bilingualSubtitles: true,
      secondSubtitleLanguage: 'zh-CN' as const
    }
    expect(hasDuplicateSubtitleLanguages(bad)).toBe(true)
  })

  it('interprets a sync receipt and surfaces replan signals', () => {
    expect(interpretSubtitleSyncReceipt(null)).toEqual({
      settingsChanged: false,
      requiresReplan: false,
      settingsPersisted: true,
      settingsVersion: null
    })
    expect(interpretSubtitleSyncReceipt({ settingsChanged: true, requiresReplan: true, settingsVersion: 4 })).toEqual({
      settingsChanged: true,
      requiresReplan: true,
      settingsPersisted: true,
      settingsVersion: 4
    })
  })

  it('recognizes a settings version conflict error (stop the round, no silent overwrite)', () => {
    expect(isSettingsVersionConflict({ data: { code: SETTINGS_VERSION_CONFLICT_CODE }, message: '' })).toBe(true)
    expect(isSettingsVersionConflict(new Error('设置版本冲突，拒绝覆盖'))).toBe(true)
    expect(isSettingsVersionConflict(new Error('other error'))).toBe(false)
  })
})
