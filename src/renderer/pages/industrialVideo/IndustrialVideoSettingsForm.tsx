import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger
} from '@cherrystudio/ui'
import { INDUSTRIAL_VIDEO_ENGLISH_VOICES } from '@shared/data/industrialVideoVoices'

import {
  createIndustrialVideoSettings,
  type IndustrialVideoSettings,
  type IndustrialVideoSubtitleLanguage,
  MAX_DURATION_SECONDS
} from './industrialVideoSettings'
import { hasDuplicateSubtitleLanguages, INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS } from './industrialVideoSubtitle'
import { INDUSTRIAL_VIDEO_FEATURED_ENGLISH_VOICES, selectIndustrialVideoVoice } from './industrialVideoVoice'

// MEA:industrial-video 制作设置保持本地交互，不触发生产任务。
export default function IndustrialVideoSettingsForm({
  settings,
  onChange,
  logoControl
}: {
  settings: IndustrialVideoSettings
  onChange: (settings: IndustrialVideoSettings) => void
  logoControl?: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId()
  // MEA:industrial-video 非精选旧草稿仍显示原标签，避免无选中或静默替换设置。
  const legacyEnglishVoice = INDUSTRIAL_VIDEO_ENGLISH_VOICES.find(
    (voice) =>
      voice.id === settings.voice && !INDUSTRIAL_VIDEO_FEATURED_ENGLISH_VOICES.some((item) => item.id === voice.id)
  )
  const englishVoices = legacyEnglishVoice
    ? [...INDUSTRIAL_VIDEO_FEATURED_ENGLISH_VOICES, legacyEnglishVoice]
    : INDUSTRIAL_VIDEO_FEATURED_ENGLISH_VOICES
  const previousLanguage = useRef(settings.subtitleLanguage)
  useEffect(() => {
    const changed = previousLanguage.current !== settings.subtitleLanguage
    previousLanguage.current = settings.subtitleLanguage
    const voice = selectIndustrialVideoVoice(
      changed && settings.voice !== '无旁白' ? '' : settings.voice,
      settings.subtitleLanguage
    )
    if (voice !== settings.voice) onChange({ ...settings, voice, narrationFollowsSubtitles: true })
  }, [settings, onChange])
  const [custom, setCustom] = useState(![30, 60, 120, 180].includes(settings.duration))
  const [durationOpen, setDurationOpen] = useState(false)
  const [editingCustomDuration, setEditingCustomDuration] = useState(false)
  const [customDuration, setCustomDuration] = useState(String(settings.duration))
  const [parameterOpen, setParameterOpen] = useState<'ratio' | 'resolution'>()
  const [subtitleLangOpen, setSubtitleLangOpen] = useState<'main' | 'second'>()
  // 仅记录进入页面时的主语言，用于提示“主语言变更需重规划与网页审核”，不改变其他字段（禁用联动）。
  const initialSubtitleLanguage = useRef(settings.subtitleLanguage)
  const invalidDuration =
    !Number.isInteger(settings.duration) || settings.duration < 1 || settings.duration > MAX_DURATION_SECONDS
  const customDurationValue = Number(customDuration)
  const invalidCustomDuration =
    !customDuration.trim() ||
    !Number.isInteger(customDurationValue) ||
    customDurationValue < 1 ||
    customDurationValue > MAX_DURATION_SECONDS
  const durationLabel = (value: number) =>
    value === 30 ? `30 ${t('industrial_video.seconds')}` : `${value / 60} ${t('industrial_video.minutes')}`
  const currentDurationLabel = custom
    ? `${settings.duration} ${t('industrial_video.seconds')}`
    : durationLabel(settings.duration)
  function choices<K extends 'style' | 'voice'>(
    key: K,
    options: readonly (readonly [IndustrialVideoSettings[K], string])[]
  ) {
    // 原选中判断：aria-pressed={settings[key] === value}；历史标签需转换为真实 ID。
    return (
      <div
        role="group"
        aria-label={t(key === 'style' ? 'industrial_video.style' : 'industrial_video.voice')}
        className="flex flex-wrap gap-1.5">
        <Label className="w-full">{t(key === 'style' ? 'industrial_video.style' : 'industrial_video.voice')}</Label>
        {options.map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={settings[key] === value ? 'secondary' : 'ghost'}
            aria-pressed={
              key === 'voice'
                ? selectIndustrialVideoVoice(settings.voice, settings.subtitleLanguage) === value
                : settings[key] === value
            }
            onClick={() => {
              onChange({ ...settings, [key]: value })
              setParameterOpen(undefined)
            }}>
            {label}
          </Button>
        ))}
      </div>
    )
  }
  return (
    <section aria-label={t('industrial_video.settings')} className="flex w-full flex-col gap-6">
      <Tabs
        value={settings.type}
        onValueChange={(value) => {
          setCustom(false)
          onChange(createIndustrialVideoSettings(value as IndustrialVideoSettings['type']))
        }}>
        <TabsList aria-label={t('industrial_video.type')} className="mx-auto flex w-fit rounded-lg bg-muted p-1">
          <TabsTrigger value="marketing" className="h-8 rounded-md px-4 text-sm">
            {t('industrial_video.marketing')}
          </TabsTrigger>
          <TabsTrigger value="assembly" className="h-8 rounded-md px-4 text-sm">
            {t('industrial_video.assembly')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <Popover
            open={durationOpen}
            onOpenChange={(open) => {
              setDurationOpen(open)
              if (!open) setEditingCustomDuration(false)
            }}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('industrial_video.duration')}
                className="text-muted-foreground">
                {currentDurationLabel}
                <ChevronDown size={12} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
              {editingCustomDuration ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Input
                        type="number"
                        autoFocus
                        aria-label={t('industrial_video.custom_duration')}
                        min={1}
                        max={MAX_DURATION_SECONDS}
                        step={1}
                        value={customDuration}
                        aria-invalid={invalidCustomDuration}
                        aria-describedby={invalidCustomDuration ? `${id}-custom-error` : undefined}
                        className="h-9 pr-10 tabular-nums"
                        onChange={(event) => setCustomDuration(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !invalidCustomDuration) {
                            setCustom(true)
                            onChange({ ...settings, duration: customDurationValue })
                            setDurationOpen(false)
                            setEditingCustomDuration(false)
                          }
                        }}
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                        {t('industrial_video.seconds')}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      disabled={invalidCustomDuration}
                      onClick={() => {
                        setCustom(true)
                        onChange({ ...settings, duration: customDurationValue })
                        setDurationOpen(false)
                        setEditingCustomDuration(false)
                      }}>
                      {t('common.confirm')}
                    </Button>
                  </div>
                  {invalidCustomDuration && (
                    <p id={`${id}-custom-error`} role="alert" className="px-1 text-xs text-destructive">
                      {t('industrial_video.invalid_duration')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {[30, 60, 120, 180].map((value) => (
                    <Button
                      key={value}
                      variant="ghost"
                      size="sm"
                      className="justify-start font-normal"
                      onClick={() => {
                        setCustom(false)
                        setCustomDuration(String(value))
                        onChange({ ...settings, duration: value })
                        setDurationOpen(false)
                      }}>
                      {durationLabel(value)}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start font-normal"
                    onClick={() => {
                      setCustomDuration(String(settings.duration))
                      setEditingCustomDuration(true)
                    }}>
                    {t('industrial_video.custom_duration')}
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
          {(['ratio', 'resolution'] as const).map((key) => (
            <Popover
              key={key}
              open={parameterOpen === key}
              onOpenChange={(open) => setParameterOpen(open ? key : undefined)}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t(key === 'ratio' ? 'industrial_video.ratio' : 'industrial_video.resolution')}
                  className="text-muted-foreground">
                  {settings[key]}
                  <ChevronDown size={12} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="flex w-32 flex-col p-1">
                {(key === 'ratio' ? (['16:9', '9:16', '1:1'] as const) : (['720P', '1080P'] as const)).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onChange({ ...settings, [key]: value })
                      setParameterOpen(undefined)
                    }}>
                    {value}
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('industrial_video.appearance')}
                className="text-xs text-muted-foreground">
                {t('industrial_video.appearance')}
                <ChevronDown size={12} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-80 flex-col gap-4 max-h-[360px] overflow-auto">
              {choices('style', [
                ['工业质感', t('industrial_video.style.industrial')],
                ['工业写实', t('industrial_video.style.realistic')],
                ['科技', t('industrial_video.style.technology')],
                ['现代', t('industrial_video.style.modern')],
                ['武侠', t('industrial_video.style.martial')],
                ['古风', t('industrial_video.style.classical')]
              ])}
              {choices('voice', [
                ...(settings.subtitleLanguage === 'en-US'
                  ? // 原展示：INDUSTRIAL_VIDEO_ENGLISH_VOICES.map(voice => [voice.id, t(`industrial_video.voice.${voice.key}`)] as const)
                    // MEA:industrial-video 仅展示精选与当前旧音色，完整17项继续用于合法性校验。
                    englishVoices.map((voice) => [voice.id, t(`industrial_video.voice.${voice.key}`)] as const)
                  : ([
                      ['温柔女声', t('industrial_video.voice.gentle_female')],
                      ['知性女声', t('industrial_video.voice.knowledge_female')],
                      ['阳光男声', t('industrial_video.voice.sunny_male')],
                      ['沉稳男声', t('industrial_video.voice.male')],
                      ['正式男声', t('industrial_video.voice.formal_male')],
                      ['男孩童声', t('industrial_video.voice.boy')]
                    ] as const)),
                ['无旁白', t('industrial_video.voice.none')]
              ])}
              {(['backgroundMusic', 'withAudio'] as const).map((key) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${id}-${key}`}>
                    {t(key === 'backgroundMusic' ? 'industrial_video.music' : 'industrial_video.with_audio')}
                  </Label>
                  <Switch
                    id={`${id}-${key}`}
                    checked={settings[key]}
                    onCheckedChange={(checked) => onChange({ ...settings, [key]: checked })}
                  />
                </div>
              ))}
              <SubtitleConfig
                id={id}
                settings={settings}
                subtitleLangOpen={subtitleLangOpen}
                setSubtitleLangOpen={setSubtitleLangOpen}
                initialSubtitleLanguage={initialSubtitleLanguage.current}
                onChange={onChange}
                duplicate={hasDuplicateSubtitleLanguages(settings)}
              />
            </PopoverContent>
          </Popover>
          {logoControl}
        </div>
      </div>
      {invalidDuration && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {t('industrial_video.invalid_duration')}
        </p>
      )}
    </section>
  )
}

/**
 * “风格·配音·字幕”弹层内的字幕配置块：字幕开关、主语言选择、双语开关、第二语言选择，
 * 以及固定为 true 的“旁白跟随字幕”。各控件相互独立（禁用联动）；第二语言不得等于主语言；
 * 主语言相对进入页面时的值发生变更时提示需模型重规划与网页审核。
 */
function SubtitleConfig({
  id,
  settings,
  subtitleLangOpen,
  setSubtitleLangOpen,
  initialSubtitleLanguage,
  onChange,
  duplicate
}: {
  id: string
  settings: IndustrialVideoSettings
  subtitleLangOpen: 'main' | 'second' | undefined
  setSubtitleLangOpen: (value: 'main' | 'second' | undefined) => void
  initialSubtitleLanguage: IndustrialVideoSubtitleLanguage
  onChange: (settings: IndustrialVideoSettings) => void
  duplicate: boolean
}) {
  const { t } = useTranslation()

  const languageSelect = (
    which: 'main' | 'second',
    value: IndustrialVideoSubtitleLanguage,
    onSelect: (code: IndustrialVideoSubtitleLanguage) => void
  ) => (
    <Popover open={subtitleLangOpen === which} onOpenChange={(open) => setSubtitleLangOpen(open ? which : undefined)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!settings.subtitle || (which === 'second' && !settings.bilingualSubtitles)}
          aria-label={t(
            which === 'main' ? 'industrial_video.subtitle_language' : 'industrial_video.second_subtitle_language'
          )}
          className="text-xs text-muted-foreground">
          {t(INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS.find((option) => option.code === value)?.labelKey ?? '')}
          <ChevronDown size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-48 flex-col p-1">
        {INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_OPTIONS.map((option) => {
          const sameAsMain = which === 'second' && option.code === settings.subtitleLanguage
          return (
            <Button
              key={option.code}
              size="sm"
              variant={value === option.code ? 'secondary' : 'ghost'}
              aria-pressed={value === option.code}
              disabled={sameAsMain}
              className="justify-start font-normal"
              onClick={() => {
                onSelect(option.code)
                setSubtitleLangOpen(undefined)
              }}>
              {t(option.labelKey)}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )

  const mainLanguageChanged = initialSubtitleLanguage !== settings.subtitleLanguage

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-subtitle`}>{t('industrial_video.subtitle')}</Label>
        <Switch
          id={`${id}-subtitle`}
          checked={settings.subtitle}
          onCheckedChange={(checked) => onChange({ ...settings, subtitle: checked })}
        />
      </div>
      {
        <div className="flex flex-col gap-2 rounded-md pl-2">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs text-muted-foreground">{t('industrial_video.subtitle_language')}</Label>
            {languageSelect('main', settings.subtitleLanguage, (code) =>
              onChange({
                ...settings,
                subtitleLanguage: code,
                voice: settings.voice === '无旁白' ? '无旁白' : selectIndustrialVideoVoice('', code),
                narrationFollowsSubtitles: true
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs text-muted-foreground" htmlFor={`${id}-bilingual`}>
              {t('industrial_video.bilingual_subtitles')}
            </Label>
            <Switch
              id={`${id}-bilingual`}
              disabled={!settings.subtitle}
              checked={settings.bilingualSubtitles}
              onCheckedChange={(checked) => onChange({ ...settings, bilingualSubtitles: checked })}
            />
          </div>
          {
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs text-muted-foreground">{t('industrial_video.second_subtitle_language')}</Label>
              {languageSelect('second', settings.secondSubtitleLanguage, (code) =>
                onChange({ ...settings, secondSubtitleLanguage: code })
              )}
            </div>
          }
          {/* {duplicate && (
            <p role="alert" className="text-xs text-destructive">
              {t('industrial_video.subtitle_language_duplicate')}
            </p>
          )} */}
          {/* <p className="text-xs text-muted-foreground">{t('industrial_video.narration_follows_subtitles')}</p> */}
          {/* {mainLanguageChanged && (
            <p role="alert" className="text-xs text-destructive">
              {t('industrial_video.subtitle_language_changed')}
            </p>
          )} */}
        </div>
      }
    </div>
  )
}
