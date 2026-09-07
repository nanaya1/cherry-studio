import { Badge, Button, CircularProgress, Divider, Scrollbar } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
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
import { useTheme } from '@renderer/hooks/useTheme'
import { ipcApi } from '@renderer/ipc'
import { popup } from '@renderer/services/popup'
import { cn } from '@renderer/utils/style'
import { Bug, FileArchive } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import DiagnosticBundleDialog from './DiagnosticBundleDialog'

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const [isPortable, setIsPortable] = useState(false)
  const [isDiagnosticDialogOpen, setIsDiagnosticDialogOpen] = useState(false)
  const { t } = useTranslation()
  const { theme } = useTheme()

  const { appUpdateState } = useAppUpdateState()

  const onCheckUpdate = () => {
    void popup.info({ title: '敬请期待', icon: null })

    // 原检查更新逻辑暂时停用，后续恢复更新能力时可重新启用。
    // if (appUpdateState.checking || appUpdateState.downloading) return
    // if (appUpdateState.downloaded) {
    //   void UpdateDialogPopup.show({ releaseInfo: appUpdateState.info || null })
    //   return
    // }
    // updateAppUpdateState({ checking: true, manualCheck: true })
    // try {
    //   await ipcApi.request('app.updater.check_for_update')
    // } catch {
    //   updateAppUpdateState({ manualCheck: false })
    //   toast.error(t('settings.about.updateError'))
    // }
    // updateAppUpdateState({ checking: false })
  }

  const debug = async () => {
    await ipcApi.request('system.toggle_dev_tools')
  }

  useEffect(() => {
    void (async () => {
      const appInfo = await ipcApi.request('app.get_info')
      setVersion(appInfo.version)
      setIsPortable(appInfo.isPortable)
    })()
  }, [])

  const isUpdateReady = appUpdateState.available && appUpdateState.downloaded && !appUpdateState.downloading
  const releaseNotesText =
    typeof appUpdateState.info?.releaseNotes === 'string'
      ? appUpdateState.info.releaseNotes.replace(/\n/g, '\n\n')
      : (appUpdateState.info?.releaseNotes?.map((note) => note.note).join('\n') ?? '')

  return (
    <SettingsContentColumn theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle className="gap-2">
          <span className="font-semibold text-[15px]">{t('settings.about.title')}</span>
          {/* GitHub 入口暂时隐藏。 */}
        </SettingTitle>

        <Divider className="my-1.5" />

        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="relative">
              <span aria-hidden="true">
                {appUpdateState.downloading && appUpdateState.downloadProgress > 0 && (
                  <div className="-top-0.5 -left-0.5 pointer-events-none absolute">
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
            </div>

            <div className="flex min-h-18 flex-col items-start justify-center">
              <div className="mb-1 font-bold text-foreground text-lg">MEA Cowork</div>
              <div className="text-muted-foreground text-sm">{t('settings.about.description')}</div>
              <Badge className="mt-1.5 rounded-md border-primary/20 bg-primary/10 px-1.5 py-0 text-[11px] text-primary leading-4">
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

        {/* 自动更新与测试计划暂时隐藏。 */}
      </SettingGroup>

      {appUpdateState.info && appUpdateState.available && (
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
        {/* 帮助文档、更新日志、官方网站、意见反馈、企业版、邮件联系与加入我们暂时隐藏。 */}
        <AboutActionRow
          id="setting-about-diagnostics"
          icon={<FileArchive className="size-4.5" />}
          title={t('settings.about.diagnostics.entry.title')}
          actionLabel={t('settings.about.diagnostics.entry.button')}
          onAction={() => setIsDiagnosticDialogOpen(true)}
        />
        <Divider className="my-3" />
        <AboutActionRow
          id="setting-about-debug-tools"
          icon={<Bug className="size-4.5" />}
          title={t('settings.about.debug.title')}
          actionLabel={t('settings.about.debug.open')}
          onAction={debug}
        />
      </SettingGroup>
      <DiagnosticBundleDialog
        appVersion={version}
        open={isDiagnosticDialogOpen}
        onOpenChange={setIsDiagnosticDialogOpen}
      />
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
