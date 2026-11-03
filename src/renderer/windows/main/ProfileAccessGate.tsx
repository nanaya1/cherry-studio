import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { EnterpriseVerificationStatus } from '@shared/ipc/schemas/enterprise'

type ProfileAccessGateProps = {
  status: EnterpriseVerificationStatus | null
}

// MEA:profile-online-login Only explicit user actions leave the blocked account.
export function ProfileAccessGate({ status }: ProfileAccessGateProps) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<'login' | 'quit' | null>(null)
  const pendingRef = useRef(false)
  const reason = status?.reason ?? 'credentials-invalid'
  const open = status?.state === 'blocked'

  const runAction = async (action: 'login' | 'quit') => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(action)
    try {
      if (action === 'quit') {
        await ipcApi.request('app.quit')
      } else {
        const result = await ipcApi.request('enterprise.session.logout')
        if (result.revocationWarning) toast.warning(result.revocationWarning)
      }
    } catch {
      toast.error(t('profile_access.action_failed'))
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        closeOnOverlayClick={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('profile_access.title')}</DialogTitle>
          <DialogDescription className="leading-6">
            {t(
              reason === 'account-disabled'
                ? 'profile_access.account_disabled'
                : reason === 'identity-changed'
                  ? 'profile_access.identity_changed'
                  : 'profile_access.credentials_invalid'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void runAction('quit')}>
            {t('profile_access.quit')}
          </Button>
          <Button
            type="button"
            disabled={pending !== null}
            loading={pending === 'login'}
            onClick={() => void runAction('login')}>
            {t(reason === 'account-disabled' ? 'profile_access.other_account' : 'profile_access.login_again')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
