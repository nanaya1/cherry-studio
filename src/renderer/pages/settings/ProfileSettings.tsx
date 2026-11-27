import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { SidebarAccountMenu } from '@renderer/components/app/SidebarAccountMenu'
import { SettingsContentColumn } from '@renderer/components/SettingsPrimitives'
import { UserProfileEditor } from '@renderer/components/UserProfileEditor'
import { usePersonalAccountDetails } from '@renderer/hooks/usePersonalAccountDetails'
import { ipcApi } from '@renderer/ipc'

export function ProfileSettings() {
  const { t } = useTranslation()
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  const { data: account } = usePersonalAccountDetails()

  return (
    <SettingsContentColumn>
      <div className="space-y-6">
        <div id="setting-profile-profile">
          <UserProfileEditor showNameEditor={status?.signedIn === false} />
          {status?.signedIn && account ? (
            <div className="min-w-0 break-words text-center">
              <div className="font-semibold text-lg">{account.displayName}</div>
              <div className="text-muted-foreground text-sm">{account.username}</div>
            </div>
          ) : status?.signedIn === false ? (
            <div className="text-center text-muted-foreground text-sm">{t('workspace.localUser')}</div>
          ) : null}
          <SidebarAccountMenu profile />
        </div>
      </div>
    </SettingsContentColumn>
  )
}
