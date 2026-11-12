import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ipcApi } from '@renderer/ipc'

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

import {
  createIndustrialVideoSettings,
  type IndustrialVideoSettings,
  MAX_DURATION_SECONDS
} from './industrialVideoSettings'

// MEA:industrial-video 制作设置保持本地交互，不触发生产任务。
export default function IndustrialVideoSettingsForm({
  settings,
  onChange,
  logoControl,
  sessionId
}: {
  settings: IndustrialVideoSettings
  onChange: (settings: IndustrialVideoSettings) => void
  logoControl?: ReactNode
  sessionId?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  const [custom, setCustom] = useState(![30, 60, 120, 180].includes(settings.duration))
  const [durationOpen, setDurationOpen] = useState(false)
  const [editingCustomDuration, setEditingCustomDuration] = useState(false)
  const [customDuration, setCustomDuration] = useState(String(settings.duration))
  const [parameterOpen, setParameterOpen] = useState<'ratio' | 'resolution'>()
  const [ttsOptions, setTtsOptions] = useState<{
    languages: { id: string; default_voice: string }[]
    voices: { id: string; language: string; name?: unknown; gender?: unknown }[]
  }>()
  useEffect(() => {
    if (!sessionId) return
    let active = true
    void ipcApi
      .request('industrial_video.tts_options_get', { sessionId })
      .then((options) => active && setTtsOptions(options))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [sessionId])
  const languageVoices = useMemo(
    () => ttsOptions?.voices.filter((voice) => voice.language === settings.language) ?? [],
    [settings.language, ttsOptions]
  )
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
    return (
      <div
        role="group"
        aria-label={t(key === 'style' ? 'industrial_video.style' : 'industrial_video.voice')}
        className="flex flex-wrap gap-1.5">
        <span className="w-full text-xs text-muted-foreground">
          {t(key === 'style' ? 'industrial_video.style' : 'industrial_video.voice')}
        </span>
        {options.map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={settings[key] === value ? 'secondary' : 'ghost'}
            aria-pressed={settings[key] === value}
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
            <PopoverContent align="end" className="flex w-80 flex-col gap-4">
              {choices('style', [
                ['工业质感', t('industrial_video.style.industrial')],
                ['工业写实', t('industrial_video.style.realistic')],
                ['科技', t('industrial_video.style.technology')],
                ['现代', t('industrial_video.style.modern')],
                ['武侠', t('industrial_video.style.martial')],
                ['古风', t('industrial_video.style.classical')]
              ])}
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">{t('industrial_video.language')}</span>
                <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                  {(ttsOptions?.languages ?? [{ id: 'zh-CN', default_voice: 'zh-CN-YunjianNeural' }]).map((language) => (
                    <Button
                      key={language.id}
                      size="sm"
                      variant={settings.language === language.id ? 'secondary' : 'ghost'}
                      aria-pressed={settings.language === language.id}
                      onClick={() => onChange({ ...settings, language: language.id, voice: language.default_voice })}>
                      {language.id}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">{t('industrial_video.voice')}</span>
                <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                  {languageVoices.map((voice) => (
                    <Button
                      key={voice.id}
                      size="sm"
                      className="justify-start"
                      variant={settings.voice === voice.id ? 'secondary' : 'ghost'}
                      aria-pressed={settings.voice === voice.id}
                      onClick={() => onChange({ ...settings, voice: voice.id })}>
                      {typeof voice.name === 'string' ? voice.name : voice.id}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    className="justify-start"
                    variant={settings.voice === '无旁白' ? 'secondary' : 'ghost'}
                    aria-pressed={settings.voice === '无旁白'}
                    onClick={() => onChange({ ...settings, voice: '无旁白' })}>
                    {t('industrial_video.voice.none')}
                  </Button>
                </div>
              </div>
              {(['backgroundMusic', 'subtitle', 'withAudio'] as const).map((key) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${id}-${key}`}>
                    {t(
                      key === 'backgroundMusic'
                        ? 'industrial_video.music'
                        : key === 'withAudio'
                          ? 'industrial_video.with_audio'
                          : 'industrial_video.subtitle'
                    )}
                  </Label>
                  <Switch
                    id={`${id}-${key}`}
                    checked={settings[key]}
                    onCheckedChange={(checked) => onChange({ ...settings, [key]: checked })}
                  />
                </div>
              ))}
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
