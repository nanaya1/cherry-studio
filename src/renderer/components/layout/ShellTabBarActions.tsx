import { Button, Tooltip } from '@cherrystudio/ui'
import { usePersistCache } from '@data/hooks/useCache'
import { loggerService } from '@logger'
import { CommandTooltip } from '@renderer/components/command'
import GlobalSearchPopup from '@renderer/components/GlobalSearch/GlobalSearchPopup'
import { getSidebarLayout, type SidebarVisibleLayout } from '@renderer/components/Sidebar'
import { useAppUpdateState } from '@renderer/hooks/useAppUpdateState'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { isMac } from '@renderer/utils/platform'
import { CircleArrowUp, PanelLeftClose, PanelLeftOpen, Search, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { WindowControls } from '../WindowControls'

const logger = loggerService.withContext('ShellTabBarActions')

export function GlobalSearchButton({ placement = 'bottom' }: { placement?: 'bottom' | 'right' }) {
  const { t } = useTranslation()

  return (
    <CommandTooltip command="app.search" label={t('globalSearch.open')} placement={placement} delay={800}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('globalSearch.open')}
        onClick={() => void GlobalSearchPopup.show()}
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:text-muted-foreground">
        <Search size={16} strokeWidth={1.8} />
      </Button>
    </CommandTooltip>
  )
}

export function SidebarCollapseButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()

  return (
    <CommandTooltip command="app.sidebar.toggle" label={t('navbar.hide_sidebar')} placement="bottom" delay={800}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('navbar.hide_sidebar')}
        onClick={onClick}
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:text-muted-foreground">
        <PanelLeftClose size={16} strokeWidth={1.8} />
      </Button>
    </CommandTooltip>
  )
}

export function SidebarExpandButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()

  return (
    <CommandTooltip command="app.sidebar.toggle" label={t('navbar.show_sidebar')} placement="bottom" delay={800}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('navbar.show_sidebar')}
        onClick={onClick}
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:text-muted-foreground">
        <PanelLeftOpen size={16} strokeWidth={1.8} />
      </Button>
    </CommandTooltip>
  )
}

export function ShellTabBarActions() {
  const { t } = useTranslation()
  const [sidebarWidth] = usePersistCache('ui.sidebar.width')
  const { appUpdateState } = useAppUpdateState()
  const sidebarLayout = getSidebarLayout(sidebarWidth)
  const isSidebarHidden = sidebarLayout === 'hidden'
  // On macOS the search lives in the sidebar title bar (full) and the collapsed
  // corner (hidden); only the icon rail borrows the tab bar's search slot.
  const showSearch = !isMac || sidebarLayout === 'icon'
  const hasUpdateAction = Boolean(appUpdateState.available && appUpdateState.downloaded && appUpdateState.info)

  const handleSettingsClick = () => {
    openSettingsTab()
  }

  const handleUpdateClick = () => {
    const releaseInfo = appUpdateState.info
    if (!releaseInfo) return

    void import('@renderer/components/UpdateDialogPopup')
      .then(({ default: UpdateDialogPopup }) => UpdateDialogPopup.show({ releaseInfo }))
      .catch((error) => logger.error('Failed to open update dialog', error as Error))
  }

  const updateLabel = appUpdateState.info
    ? t('settings.about.updateAvailable', { version: appUpdateState.info.version })
    : t('button.update_available')

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <div className="flex items-center gap-1 pr-2 [-webkit-app-region:no-drag]">
        {hasUpdateAction && (
          <Tooltip content={updateLabel} placement="bottom" delay={800}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={updateLabel}
              onClick={handleUpdateClick}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors hover:bg-accent">
              <CircleArrowUp className="lucide-custom size-[18px] text-success" strokeWidth={1.8} />
            </Button>
          </Tooltip>
        )}
        {isSidebarHidden && (
          <CommandTooltip command="app.settings.open" label={t('settings.title')} placement="bottom" delay={800}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('settings.title')}
              onClick={handleSettingsClick}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:text-muted-foreground">
              <Settings size={16} strokeWidth={1.8} />
            </Button>
          </CommandTooltip>
        )}
        {showSearch && <GlobalSearchButton />}
      </div>

      <WindowControls />
    </div>
  )
}

export function SidebarShellActions({
  layout,
  onSettingsClick
}: {
  layout: SidebarVisibleLayout
  onFeedbackClick: () => void
  onSettingsClick: () => void
  onOverlayOpenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation()

  if (layout === 'icon') {
    return (
      <CommandTooltip command="app.settings.open" label={t('settings.title')} placement="right" delay={800}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('settings.title')}
          onClick={onSettingsClick}
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground dark:text-muted-foreground">
          <Settings size={18} strokeWidth={1.6} />
        </Button>
      </CommandTooltip>
    )
  }
  return null
}
