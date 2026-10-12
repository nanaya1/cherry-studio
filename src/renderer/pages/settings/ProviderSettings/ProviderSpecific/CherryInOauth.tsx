import { RefreshCw } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button, Skeleton } from '@cherrystudio/ui'
import { Cherryin, Xuelang } from '@cherrystudio/ui/icons/providers'
import { loggerService } from '@logger'
import { useProvider } from '@renderer/hooks/useProvider'
import { ipcApi } from '@renderer/ipc'
import { oauthCardClasses } from '@renderer/pages/settings/ProviderSettings/primitives/ProviderSettingsPrimitives'
import { oauthWithCherryIn, provisionOAuthApiKeys } from '@renderer/services/oauth'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { openExternalWebsite } from '@renderer/services/website'
import { cn } from '@renderer/utils/style'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { oauthErrorCodes } from '@shared/ipc/errors/oauth'
import type { CherryInBalance } from '@shared/ipc/schemas/cherryin'
import { XUELANG_API_HOST } from '@shared/utils/constants'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

const logger = loggerService.withContext('CherryInOauth')

const GATEWAY_PRESENTATION = {
  cherryin: {
    oauthServer: 'https://open.cherryin.ai',
    topupUrl: 'https://open.cherryin.ai/console/topup',
    i18nNs: 'cherryIn'
  },
  xuelang: {
    oauthServer: XUELANG_API_HOST,
    topupUrl: null,
    i18nNs: 'xuelang'
  }
} as const

type GatewayProviderId = keyof typeof GATEWAY_PRESENTATION

const resolveGateway = (providerId: string): GatewayProviderId | undefined => {
  if (providerId === SystemProviderIds.cherryin) return 'cherryin'
  if (providerId === SystemProviderIds.xuelang) return 'xuelang'
  return undefined
}

interface CherryInOauthProps {
  providerId: string
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-'
  }

  return `$${value.toFixed(2)}`
}

const CherryInOauth: FC<CherryInOauthProps> = ({ providerId }) => {
  const { provider, updateProvider, addApiKey, deleteApiKey } = useProvider(providerId)
  const { t } = useTranslation()
  const gateway = provider ? resolveGateway(provider.id) : undefined
  const presentation = gateway ? GATEWAY_PRESENTATION[gateway] : undefined

  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isProvisioningKey, setIsProvisioningKey] = useState(false)
  const [isCancellingLogin, setIsCancellingLogin] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [balanceInfo, setBalanceInfo] = useState<CherryInBalance | null>(null)
  const [oauthTokenOverride, setOauthTokenOverride] = useState<boolean | null>(null)
  // `oauth.has_token` returns only a boolean — the access/refresh tokens stay in
  // the main process and never reach the renderer (null = status not loaded yet).
  const [remoteHasOAuthToken, setRemoteHasOAuthToken] = useState<boolean | null>(null)
  const topupInProgressRef = useRef(false)
  const signInRequestIdRef = useRef<string | null>(null)

  const refreshHasToken = useCallback(async () => {
    if (!gateway) return
    try {
      setRemoteHasOAuthToken(await ipcApi.request('oauth.has_token', { providerId: gateway }))
    } catch (error) {
      logger.warn('Failed to check gateway OAuth token status:', error as Error)
      setRemoteHasOAuthToken(false)
    }
  }, [gateway])

  useEffect(() => {
    void refreshHasToken()
  }, [refreshHasToken])

  const hasOAuthKey = provider?.apiKeys?.some((key) => key.label === 'OAuth' && key.isEnabled) ?? false
  const hasOAuthToken = oauthTokenOverride ?? remoteHasOAuthToken ?? false
  const isOAuthLoggedIn = hasOAuthKey && hasOAuthToken

  const fetchData = useCallback(async () => {
    if (!gateway || !presentation) return
    setIsLoadingData(true)
    try {
      const balance = await ipcApi.request(
        'cherryin.get_balance',
        gateway === SystemProviderIds.xuelang
          ? { apiHost: presentation.oauthServer, providerId: gateway }
          : { apiHost: presentation.oauthServer }
      )
      setBalanceInfo(balance)
    } catch (error) {
      logger.warn('Failed to fetch balance:', error as Error)
      setBalanceInfo(null)
    } finally {
      setIsLoadingData(false)
    }
  }, [gateway, presentation])

  useEffect(() => {
    if (isOAuthLoggedIn) {
      void fetchData()
    } else {
      setBalanceInfo(null)
    }
  }, [fetchData, isOAuthLoggedIn])

  useEffect(() => {
    if (oauthTokenOverride !== null && remoteHasOAuthToken !== null && remoteHasOAuthToken === oauthTokenOverride) {
      setOauthTokenOverride(null)
    }
  }, [oauthTokenOverride, remoteHasOAuthToken])

  // Top-up happens in the system browser,
  // so the balance refresh must wait for the user to come back.
  useEffect(() => {
    const handleWindowFocus = () => {
      if (topupInProgressRef.current) {
        topupInProgressRef.current = false
        void fetchData()
      }
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [fetchData])

  const showOAuthError = useCallback(
    (error: unknown) => {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      const errorKey = code ? `settings.provider.oauth.error_codes.${code}` : 'settings.provider.oauth.error'
      toast.error(t(errorKey, { defaultValue: t('settings.provider.oauth.error') }))
    },
    [t]
  )

  const saveOAuthKeys = useCallback(
    async (apiKeys: string) => {
      const keys = apiKeys
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      await Promise.all(keys.map((key) => addApiKey(key, 'OAuth')))
      await updateProvider({ isEnabled: true })
      setOauthTokenOverride(true)
      void refreshHasToken()
      await fetchData()
      toast.success(t('auth.get_key_success'))
    },
    [addApiKey, fetchData, refreshHasToken, t, updateProvider]
  )

  const handleProvisionApiKey = useCallback(async () => {
    if (!gateway) return
    setIsProvisioningKey(true)
    try {
      await saveOAuthKeys(await provisionOAuthApiKeys(gateway))
    } catch (error) {
      logger.error('Failed to provision OAuth API keys:', error as Error)
      showOAuthError(error)
    } finally {
      setIsProvisioningKey(false)
    }
  }, [gateway, saveOAuthKeys, showOAuthError])

  const handleOAuthLogin = useCallback(async () => {
    if (!gateway || !presentation || signInRequestIdRef.current) return

    const requestId = crypto.randomUUID()
    signInRequestIdRef.current = requestId
    setIsLoggingIn(true)
    try {
      await oauthWithCherryIn(saveOAuthKeys, {
        oauthServer: presentation.oauthServer,
        ...(gateway === SystemProviderIds.xuelang ? { providerId: gateway } : {}),
        requestId
      })
    } catch (error) {
      if (error instanceof IpcError && error.code === oauthErrorCodes.SIGN_IN_CANCELLED) return
      logger.error('OAuth error:', error as Error)
      showOAuthError(error)
    } finally {
      if (signInRequestIdRef.current === requestId) {
        signInRequestIdRef.current = null
        setIsLoggingIn(false)
      }
    }
  }, [gateway, presentation, saveOAuthKeys, showOAuthError])

  const handleCancelLogin = useCallback(async () => {
    const requestId = signInRequestIdRef.current
    if (!requestId) return

    setIsCancellingLogin(true)
    try {
      await ipcApi.request('oauth.cancel_sign_in', { providerId: SystemProviderIds.cherryin, requestId })
    } catch (error) {
      logger.error('Failed to cancel CherryIN OAuth login:', error as Error)
      toast.error(t('settings.provider.oauth.error'))
    } finally {
      setIsCancellingLogin(false)
    }
  }, [t])

  const handleLogout = useCallback(async () => {
    if (!gateway || !presentation) return
    const confirmed = await popup.confirm({
      title: t('settings.provider.oauth.logout'),
      content: t('settings.provider.oauth.logout_confirm'),
      centered: true
    })
    if (!confirmed) return

    setIsLoggingOut(true)

    try {
      await ipcApi.request(
        'cherryin.logout',
        gateway === SystemProviderIds.xuelang
          ? { apiHost: presentation.oauthServer, providerId: gateway }
          : { apiHost: presentation.oauthServer }
      )
      setOauthTokenOverride(false)
      setBalanceInfo(null)

      void refreshHasToken()

      const oauthKeys = provider?.apiKeys.filter((key) => key.label === 'OAuth') ?? []
      const deleteResults = await Promise.allSettled(oauthKeys.map((key) => deleteApiKey(key.id)))
      const rejectedDeletes = deleteResults.filter((result) => result.status === 'rejected')
      if (rejectedDeletes.length > 0) {
        logger.warn(`Failed to delete ${rejectedDeletes.length} CherryIN OAuth key(s) after logout`)
        toast.warning(t('settings.provider.oauth.logout_warning'))
        return
      }

      toast.success(t('settings.provider.oauth.logout_success'))
    } catch (error) {
      logger.error('Logout error:', error as Error)
      toast.warning(t('settings.provider.oauth.logout_warning'))
    } finally {
      setIsLoggingOut(false)
    }
  }, [deleteApiKey, gateway, presentation, provider?.apiKeys, refreshHasToken, t])

  const handleTopup = useCallback(() => {
    if (!presentation?.topupUrl) return
    topupInProgressRef.current = true
    void openExternalWebsite(presentation.topupUrl)
  }, [presentation])

  if (!provider || !gateway || !presentation) {
    return null
  }

  if (remoteHasOAuthToken === null && hasOAuthKey) {
    return (
      <div className={oauthCardClasses.container}>
        <div className={oauthCardClasses.shell}>
          <Skeleton className="h-5 w-55" />
          <Skeleton className="mt-2 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-[82%]" />
        </div>
      </div>
    )
  }

  if (!isOAuthLoggedIn) {
    const statusText = hasOAuthKey
      ? t('settings.provider.oauth.session_expired')
      : t(`settings.provider.oauth.${presentation.i18nNs}.not_logged_in`)
    const actionText = hasOAuthToken
      ? t('settings.provider.oauth.provision_key')
      : t(`settings.provider.oauth.${presentation.i18nNs}.login_button`)

    return (
      <div className={oauthCardClasses.container}>
        <div className={oauthCardClasses.shell}>
          <div className={oauthCardClasses.loggedInRow}>
            <div className={oauthCardClasses.profileMeta}>
              <ProviderAvatar gateway={gateway} />
              <div className={oauthCardClasses.nameBlock}>
                <div className={oauthCardClasses.loggedInName}>{statusText}</div>
                <div className={cn(oauthCardClasses.loggedInEmail, 'text-muted-foreground')}>
                  {t(`settings.provider.oauth.${presentation.i18nNs}.tagline`)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="emphasis"
                onClick={hasOAuthToken ? handleProvisionApiKey : handleOAuthLogin}
                disabled={isLoggingIn || isProvisioningKey}>
                {isLoggingIn || isProvisioningKey ? <RefreshCw className="size-4 animate-spin" aria-hidden /> : null}
                {actionText}
              </Button>
              {isLoggingIn && gateway === SystemProviderIds.cherryin ? (
                <Button variant="outline" onClick={handleCancelLogin} disabled={isCancellingLogin}>
                  {t('common.cancel')}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const profileName =
    balanceInfo?.profile?.displayName || balanceInfo?.profile?.username || balanceInfo?.profile?.email || provider.name
  const profileEmail = balanceInfo?.profile?.email || t(`settings.provider.oauth.${presentation.i18nNs}.logged_in`)
  const profileGroup =
    balanceInfo?.profile?.group && balanceInfo.profile.group !== 'default' ? balanceInfo.profile.group : null

  return (
    <div className={oauthCardClasses.container}>
      <div className={cn(oauthCardClasses.shellLoggedIn, 'text-muted-foreground')}>
        <div className={oauthCardClasses.loggedInRow}>
          <div className={oauthCardClasses.profileMeta}>
            <ProviderAvatar gateway={gateway} />
            <div className={oauthCardClasses.nameBlock}>
              <div className={oauthCardClasses.nameRow}>
                <div className={cn(oauthCardClasses.loggedInName, 'text-foreground')}>{profileName}</div>
                {profileGroup ? <span className={oauthCardClasses.badge}>{profileGroup}</span> : null}
              </div>
              <div className={cn(oauthCardClasses.loggedInEmail, 'text-muted-foreground')}>{profileEmail}</div>
            </div>
          </div>
          <div className={cn(oauthCardClasses.loggedInActions, 'gap-1.5')}>
            <div className={cn(oauthCardClasses.inlineBalanceBlock, 'mr-1 flex items-baseline gap-1.5 text-left')}>
              <p className={cn(oauthCardClasses.inlineBalanceLabel, 'text-muted-foreground')}>
                {t('settings.provider.oauth.balance')}
              </p>
              <div className={cn(oauthCardClasses.inlineBalanceValue, 'text-foreground')}>
                {isLoadingData && !balanceInfo ? (
                  <Skeleton className={`${oauthCardClasses.balanceValueSkeleton} h-5`} />
                ) : (
                  formatCurrency(balanceInfo?.balance)
                )}
              </div>
            </div>
            {presentation.topupUrl ? (
              <Button
                className={cn(oauthCardClasses.topupPrimaryButton, 'h-7 px-2.5 py-0')}
                onClick={handleTopup}
                size="sm"
                variant="default">
                {t('settings.provider.oauth.topup')}
              </Button>
            ) : null}
            <Button
              className={cn(oauthCardClasses.logoutCompact, 'h-7 px-2 py-0 text-muted-foreground')}
              disabled={isLoggingOut}
              onClick={handleLogout}
              variant="ghost">
              {t('settings.provider.oauth.logout')}
            </Button>
          </div>
        </div>
        <p className={cn(oauthCardClasses.serviceAttribution, 'text-muted-foreground')}>
          <Trans
            i18nKey={`settings.provider.oauth.${presentation.i18nNs}.service_attribution`}
            components={{
              link: (
                <a
                  key="gateway-service-link"
                  className={cn(oauthCardClasses.serviceLink, 'text-muted-foreground')}
                  href={presentation.oauthServer}
                  rel="noreferrer"
                  target="_blank"
                />
              )
            }}
          />
        </p>
      </div>
    </div>
  )
}

const ProviderAvatar: FC<{ gateway: GatewayProviderId }> = ({ gateway }) => {
  if (gateway === SystemProviderIds.xuelang) {
    return <Xuelang.Avatar shape="circle" size={40} />
  }
  return <Cherryin.Avatar shape="circle" size={40} />
}

export default CherryInOauth
