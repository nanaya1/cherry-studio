import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { ipcApi } from '@renderer/ipc'

import CherryInOauth from './CherryInOauth'

export default function XuelangAccountSettings({ providerId }: { providerId: string }) {
  const { t } = useTranslation()
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  const { error, isValidating } = useSWR(
    status?.signedIn ? 'enterprise.personal.sync_models' : null,
    () => ipcApi.request('enterprise.personal.sync_models'),
    { revalidateOnMount: true, revalidateOnFocus: false, shouldRetryOnError: false }
  )

  if (!status) return null
  if (!status.signedIn) return <CherryInOauth providerId={providerId} />

  if (!error || isValidating) return null
  return (
    <span role="status" className="text-muted-foreground text-xs">
      {t('settings.models.manage.sync_pull_failed')}
    </span>
  )
}
