import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { debounce } from 'es-toolkit/compat'
import { Bug, Rss /* Stethoscope */ } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Badge,
  Button,
  CircularProgress,
  Divider,
  Scrollbar,
  SegmentedControl,
  Switch,
  Tooltip
} from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import AppLogo from '@renderer/assets/images/logo.png'
import { DoctorPopup } from '@renderer/components/doctor'
// import FeedbackDialog from '@renderer/components/feedback/FeedbackDialog'
import LogoAvatar from '@renderer/components/icons/LogoAvatar'
import IndicatorLight from '@renderer/components/IndicatorLight'
import { ReleaseNotes } from '@renderer/components/ReleaseNotes'
import {
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingsContentColumn,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useAppUpdateState } from '@renderer/hooks/useAppUpdateState'
import { useOpenReleaseNotes } from '@renderer/hooks/useOpenReleaseNotes'
import { useTheme } from '@renderer/hooks/useTheme'
// import i18n from '@renderer/i18n/resolver'
import { ipcApi } from '@renderer/ipc'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
// import { openExternalWebsite } from '@renderer/services/website'
import { cn } from '@renderer/utils/style'
import { UpgradeChannel } from '@shared/data/preference/preferenceTypes'
import { DOCTOR_OPEN_QUERY_PARAM, type DoctorPanel } from '@shared/utils/doctor'

const MEA_ENABLE_CHERRY_AUTO_UPDATE = false

const AboutSettings: FC = () => {
  const [autoCheckUpdate, setAutoCheckUpdate] = usePreference('app.dist.auto_update.enabled')
  const [testPlan, setTestPlan] = usePreference('app.dist.test_plan.enabled')
  const [testChannel, setTestChannel] = usePreference('app.dist.test_plan.channel')

  const [version, setVersion] = useState('')
  const [isPortable, setIsPortable] = useState(false)
  // Cherry 官方反馈入口已停用，保留原状态声明便于回滚。
  // const [feedbackOpen, setFeedbackOpen] = useState(false)
  const { t } = useTranslation()
  const { theme } = useTheme()
  const showReleases = useOpenReleaseNotes()
  const location = useLocation()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Partial<Record<typeof DOCTOR_OPEN_QUERY_PARAM, DoctorPanel>>
  const consumedDoctorPanelRef = useRef<DoctorPanel | undefined>(undefined)

  const { appUpdateState, updateAppUpdateState } = useAppUpdateState()

  useEffect(() => {
    const initialPanel = search[DOCTOR_OPEN_QUERY_PARAM]
    if (!initialPanel) {
      consumedDoctorPanelRef.current = undefined
      return
    }
    if (consumedDoctorPanelRef.current === initialPanel) return
    consumedDoctorPanelRef.current = initialPanel

    void navigate({
      to: location.pathname,
      search: (previous: Record<string, unknown>) => {
        const remaining = { ...previous }
        delete remaining[DOCTOR_OPEN_QUERY_PARAM]
        return remaining
      },
      replace: true
    })
    void DoctorPopup.show({ initialPanel })
  }, [location.pathname, navigate, search])

  const onCheckUpdate = debounce(
    () => {
      void popup.info({ title: '敬请期待', icon: null })
    },
    2000,
    { leading: true, trailing: false }
  )

  // const onOpenWebsite = (url: string) => {
  //   void openExternalWebsite(url)
  // }

  // const mailto = async () => {
  //   const email = 'support@cherry-ai.com'
  //   const subject = 'Cherry Studio Feedback'
  //   const version = (await ipcApi.request('app.get_info')).version
  //   const platform = window.electron.process.platform
  //   const url = `mailto:${email}?subject=${subject}&body=%0A%0AVersion: ${version} | Platform: ${platform}`
  //   onOpenWebsite(url)
  // }

  const debug = async () => {
    await ipcApi.request('system.toggle_dev_tools')
  }

  // const showEnterprise = async () => {
  //   onOpenWebsite('https://enterprise.cherry-ai.com')
  // }

  const currentChannelByVersion =
    [
      { pattern: `-${UpgradeChannel.BETA}.`, channel: UpgradeChannel.BETA },
      { pattern: `-${UpgradeChannel.RC}.`, channel: UpgradeChannel.RC }
    ].find(({ pattern }) => version.includes(pattern))?.channel || UpgradeChannel.LATEST

  const handleTestChannelChange = async (value: UpgradeChannel) => {
    if (testPlan && currentChannelByVersion !== UpgradeChannel.LATEST && value !== currentChannelByVersion) {
      toast.warning(t('settings.general.test_plan.version_channel_not_match'))
    }
    void setTestChannel(value)
    updateAppUpdateState({
      available: false,
      info: null,
      downloaded: false,
      checking: false,
      downloading: false,
      downloadProgress: 0
    })
  }

  const getAvailableTestChannels = () => {
    return [
      {
        tooltip: t('settings.general.test_plan.rc_version_tooltip'),
        label: t('settings.general.test_plan.rc_version'),
        value: UpgradeChannel.RC
      },
      {
        tooltip: t('settings.general.test_plan.beta_version_tooltip'),
        label: t('settings.general.test_plan.beta_version'),
        value: UpgradeChannel.BETA
      }
    ]
  }

  const handleSetTestPlan = (value: boolean) => {
    void setTestPlan(value)
    updateAppUpdateState({
      available: false,
      info: null,
      downloaded: false,
      checking: false,
      downloading: false,
      downloadProgress: 0
    })

    if (value === true) {
      void setTestChannel(getTestChannel())
    }
  }

  const getTestChannel = () => {
    if (testChannel === UpgradeChannel.LATEST) {
      return UpgradeChannel.RC
    }
    return testChannel
  }

  useEffect(() => {
    void (async () => {
      const appInfo = await ipcApi.request('app.get_info')
      setVersion(appInfo.version)
      setIsPortable(appInfo.isPortable)
    })()
  }, [])

  // Cherry 官方文档、官网、企业站、反馈邮箱和招聘页不作为 MEA Cowork 入口。
  // const onOpenDocs = () => {
  //   const isChinese = i18n.language.startsWith('zh')
  //   void openExternalWebsite(isChinese ? 'https://docs.cherry-ai.com/' : 'https://docs.cherry-ai.com/docs/en-us')
  // }

  const testChannels = getAvailableTestChannels()
  const isUpdateReady = appUpdateState.available && appUpdateState.downloaded && !appUpdateState.downloading
  const releaseNotesText =
    typeof appUpdateState.info?.releaseNotes === 'string'
      ? appUpdateState.info.releaseNotes.replace(/\n/g, '\n\n')
      : (appUpdateState.info?.releaseNotes?.map((note) => note.note).join('\n') ?? '')

  return (
    <SettingsContentColumn theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.about.title')}</SettingTitle>

        <Divider className="my-1.5" />

        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span aria-hidden="true" className="relative">
              {appUpdateState.downloading && appUpdateState.downloadProgress > 0 && (
                <div className="pointer-events-none absolute -top-0.5 -left-0.5">
                  <CircularProgress
                    value={appUpdateState.downloadProgress}
                    size={76}
                    strokeWidth={4}
                    shape="square"
                    className="stroke-transparent"
                    progressClassName="stroke-[#67ad5b]"
                  />
                </div>
              )}
              <LogoAvatar logo={AppLogo} size={72} className="rounded-full" alt="" />
            </span>

            <div className="flex min-h-18 flex-col items-start justify-center">
              <div className="mb-1 text-lg font-bold text-foreground">MEA Cowork</div>
              <div className="text-muted-foreground text-sm">{t('settings.about.description')}</div>
              <Badge className="mt-1.5 rounded-md border-primary/20 bg-primary/10 px-1.5 py-0 text-[11px] leading-4 text-primary">
                v{version}
              </Badge>
            </div>
          </div>

          {!isPortable && (
            <div className="flex shrink-0 items-center justify-end">
              <Button
                size="sm"
                variant={isUpdateReady ? 'default' : 'outline'}
                loading={appUpdateState.checking}
                onClick={onCheckUpdate}
                disabled={appUpdateState.downloading}
                className={cn(
                  'w-fit! min-w-0! shrink-0',
                  isUpdateReady &&
                    'bg-success text-primary-foreground hover:bg-success/90 dark:bg-success dark:text-primary-foreground dark:hover:bg-success/90'
                )}>
                {appUpdateState.downloading
                  ? t('settings.about.downloading')
                  : appUpdateState.available
                    ? t('settings.about.checkUpdate.available')
                    : t('settings.about.checkUpdate.label')}
              </Button>
            </div>
          )}
        </div>

        {/* MEA Cowork 不走 Cherry 自动更新通道；保留 v2.1.4 控件和逻辑以便后续恢复。 */}
        {MEA_ENABLE_CHERRY_AUTO_UPDATE && !isPortable && (
          <>
            <Divider className="my-3" />
            <SettingRow id="setting-about-auto-check-update" className="scroll-mt-6 gap-3">
              <SettingRowTitle>{t('settings.general.auto_check_update.title')}</SettingRowTitle>
              <Switch checked={autoCheckUpdate} onCheckedChange={(v) => setAutoCheckUpdate(v)} />
            </SettingRow>

            <Divider className="my-3" />
            <SettingRow className="flex-nowrap gap-6">
              <div className="flex min-w-0 flex-1 items-center justify-between gap-6">
                <SettingRowTitle>{t('settings.general.test_plan.title')}</SettingRowTitle>
                {testPlan && (
                  <SegmentedControl<UpgradeChannel>
                    value={getTestChannel()}
                    onValueChange={handleTestChannelChange}
                    options={testChannels.map((option) => ({
                      value: option.value,
                      label: (
                        <Tooltip content={option.tooltip}>
                          <span>{option.label}</span>
                        </Tooltip>
                      )
                    }))}
                    size="sm"
                  />
                )}
              </div>
              <Tooltip
                content={t('settings.general.test_plan.tooltip')}
                classNames={{ placeholder: 'inline-flex items-center' }}>
                <Switch className="shrink-0" checked={testPlan} onCheckedChange={(v) => handleSetTestPlan(v)} />
              </Tooltip>
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {MEA_ENABLE_CHERRY_AUTO_UPDATE && appUpdateState.info && appUpdateState.available && (
        <SettingGroup theme={theme}>
          <SettingRow className="gap-3">
            <SettingRowTitle className="gap-2.5">
              {t('settings.about.updateAvailable', { version: appUpdateState.info.version })}
              <IndicatorLight color="var(--success)" />
            </SettingRowTitle>
          </SettingRow>
          <Divider className="my-3" />
          <Scrollbar className="max-h-96 overflow-x-hidden pr-2">
            <ReleaseNotes content={releaseNotesText} />
          </Scrollbar>
        </SettingGroup>
      )}

      <SettingGroup theme={theme}>
        {/* Cherry 官方更新日志外链在 MEA Cowork 中保持隐藏。 */}
        {MEA_ENABLE_CHERRY_AUTO_UPDATE && (
          <AboutActionRow
            icon={<Rss className="size-4.5" />}
            title={t('settings.about.releases.title')}
            actionLabel={t('settings.about.releases.button')}
            onAction={showReleases}
          />
        )}
        <AboutActionRow
          id="setting-about-debug-tools"
          icon={<Bug className="size-4.5" />}
          title={t('settings.about.debug.title')}
          actionLabel={t('settings.about.debug.open')}
          onAction={debug}
        />
      </SettingGroup>
    </SettingsContentColumn>
  )
}

function AboutActionRow({
  actionLabel,
  icon,
  id,
  onAction,
  title
}: {
  actionLabel: string
  icon: ReactNode
  id?: string
  onAction: () => void | Promise<void>
  title: string
}) {
  return (
    <SettingRow id={id} className={id ? 'scroll-mt-6 gap-3' : 'gap-3'}>
      <SettingRowTitle className="gap-2.5">
        {icon}
        {title}
      </SettingRowTitle>
      <Button size="sm" onClick={() => void onAction()} variant="outline">
        {actionLabel}
      </Button>
    </SettingRow>
  )
}

export default AboutSettings
