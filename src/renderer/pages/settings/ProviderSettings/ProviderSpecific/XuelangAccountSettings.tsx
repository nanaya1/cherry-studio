import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button, Tooltip } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { cn } from '@renderer/utils/style'

import CherryInOauth from './CherryInOauth'

export default function XuelangAccountSettings({ providerId }: { providerId: string }) {
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  return status?.signedIn === false ? <CherryInOauth providerId={providerId} /> : null
}

export function XuelangModelRefresh() {
  const { t } = useTranslation()
  const { error, isValidating, mutate } = useSWR(
    'enterprise.personal.sync_models',
    () => ipcApi.request('enterprise.personal.sync_models'),
    { revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  )

  const failed = Boolean(error) && !isValidating
  const label = t(failed ? 'common.retry' : 'common.refresh')
  const failureMessage = t('settings.models.manage.sync_pull_failed')

  return (
    <>
      <Tooltip content={failed ? failureMessage : label}>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={label}
          disabled={isValidating}
          onClick={() => void mutate()}>
          <RefreshCw className={cn(isValidating && 'animate-spin', failed && 'text-destructive')} aria-hidden />
        </Button>
      </Tooltip>
      {failed && (
        <span role="status" className="sr-only">
          {failureMessage}
        </span>
      )}
    </>
  )
}
