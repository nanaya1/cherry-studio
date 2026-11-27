import { LogIn, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'

import UserPopup from '../UserPopup'

export function SidebarAccountMenu({ close, profile = false }: { close?: () => void; profile?: boolean }) {
  const { t } = useTranslation()
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  const signedIn = status?.signedIn === true
  const ActionIcon = signedIn ? LogOut : LogIn

  const login = () => {
    close?.()
    void UserPopup.show({ loginOnly: true })
  }

  const logout = async () => {
    close?.()
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

  if (!status) return null

  const label = t(signedIn ? 'settings.provider.org_service.logout' : 'settings.provider.org_service.login')
  const onClick = signedIn ? () => void logout() : login

  if (profile) {
    return (
      <div className="flex justify-center pt-3">
        <Button variant="ghost" onClick={onClick}>
          <ActionIcon aria-hidden />
          {label}
        </Button>
      </div>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="h-8 min-h-8 w-full justify-start gap-2 rounded-md bg-transparent px-2 py-0 text-[13px] text-foreground leading-5">
      <ActionIcon className="!text-muted-foreground size-4" aria-hidden />
      <span className="min-w-0 flex-1 text-left">{label}</span>
    </Button>
  )
}
