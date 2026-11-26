import { Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, AvatarImage, Button, ColFlex, EmojiAvatar } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import { CommandShortcut } from '@renderer/components/command'
import useAvatar from '@renderer/hooks/useAvatar'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { isEmoji } from '@renderer/utils/naming'

import { AppearanceMenu } from './layout/AppearanceMenu'
import { NotificationCenterButton } from './NotificationCenter'

export function UserAccountPanel({
  onRequestClose,
  onNotificationsOpen,
  children
}: {
  onRequestClose?: () => void
  onNotificationsOpen?: () => void
  children?: ReactNode
}) {
  const [userName] = usePreference('app.user.name')
  const { t } = useTranslation()
  const avatar = useAvatar()
  const accountDisplayName = userName || t('settings.profile.title')

  const handleOpenAccountDetails = () => {
    onRequestClose?.()
    openSettingsTab('/settings/profile')
  }

  const handleOpenSettings = () => {
    onRequestClose?.()
    openSettingsTab()
  }

  return (
    <ColFlex className="w-56 p-1.5">
      <ColFlex className="pb-1">
        <Button
          type="button"
          variant="ghost"
          aria-label={t('settings.general.user_name.label')}
          className="h-auto min-h-9 w-full items-center justify-start gap-2 px-2 py-1 text-left"
          onClick={handleOpenAccountDetails}
          size="sm">
          <span className="flex w-4 shrink-0 items-center justify-center">
            {avatar && isEmoji(avatar) ? (
              <EmojiAvatar size={20} fontSize={12} className="shrink-0">
                {avatar}
              </EmojiAvatar>
            ) : (
              <Avatar className="size-5 shrink-0 rounded-full">
                <AvatarImage src={avatar} className="object-cover" />
              </Avatar>
            )}
          </span>
          <ColFlex className="min-w-0 flex-1 gap-0">
            <span className="truncate font-medium text-[13px] text-foreground leading-[18px]">
              {accountDisplayName}
            </span>
          </ColFlex>
        </Button>
      </ColFlex>
      <ColFlex className="border-border-subtle gap-0.5 border-t py-1">
        <NotificationCenterButton
          onRequestClose={() => {
            onNotificationsOpen?.()
            onRequestClose?.()
          }}
        />
        <AppearanceMenu onRequestClose={onRequestClose} />
        {children}
      </ColFlex>
      <ColFlex className="border-border-subtle border-t pt-1">
        <Button
          className="h-8 min-h-8 w-full justify-start gap-2 rounded-md bg-transparent px-2 py-0 text-[13px] text-foreground leading-5"
          onClick={handleOpenSettings}
          size="sm"
          variant="ghost">
          <Settings className="!text-muted-foreground size-4" aria-hidden />
          <span className="min-w-0 flex-1 text-left">{t('common.settings')}</span>
          <CommandShortcut
            command="app.settings.open"
            className="ml-auto h-auto min-w-0 rounded-none bg-transparent p-0 text-[13px] shadow-none"
          />
        </Button>
      </ColFlex>
    </ColFlex>
  )
}
