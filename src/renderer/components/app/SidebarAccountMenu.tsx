import { LogIn, LogOut, Pencil, Repeat2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'

import UserPopup from '../UserPopup'

export function SidebarAccountMenu({
  name,
  description,
  close
}: {
  name: string
  description?: string
  close: () => void
}) {
  const { t } = useTranslation()
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  const signedIn = status?.signedIn === true
  const LoginIcon = signedIn ? Repeat2 : LogIn

  const logout = async () => {
    close()
    try {
      const result = await ipcApi.request('enterprise.personal.change_account', {
        credentials: null,
        confirmation: {
          title: t('settings.provider.org_service.logout'),
          message: t('settings.provider.org_service.logout_local_space'),
          cancel: t('common.cancel'),
          proceed: t('settings.provider.org_service.logout')
        }
      })
      if (result === 'busy') toast.error(t('settings.provider.org_service.logout_failed'))
    } catch {
      toast.error(t('settings.provider.org_service.logout_failed'))
    }
  }

  return (
    <div className="flex flex-col">
      <div className="mx-1 mb-1 rounded-lg bg-accent/60 px-2.5 py-2">
        <div className="truncate font-medium text-sm">{name}</div>
        {description && <div className="truncate text-muted-foreground text-xs">{description}</div>}
      </div>
      {status?.signedIn === false && (
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            close()
            void UserPopup.show({ profileOnly: true })
          }}>
          <Pencil />
          {t('settings.provider.org_service.edit_local_profile')}
        </Button>
      )}
      {status && (
        <div className="mt-1 flex flex-col border-border-subtle border-t pt-1">
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              close()
              void UserPopup.show({ loginOnly: true })
            }}>
            <LoginIcon />
            {t(signedIn ? 'settings.provider.org_service.switch_account' : 'settings.provider.org_service.login')}
          </Button>
          {signedIn && (
            <Button variant="ghost" className="justify-start" onClick={() => void logout()}>
              <LogOut />
              {t('settings.provider.org_service.logout')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
