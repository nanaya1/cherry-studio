import { Button, Skeleton } from '@cherrystudio/ui'
import { Cherryin, Xuelang } from '@cherrystudio/ui/icons/providers'
import { loggerService } from '@logger'
import { useProvider } from '@renderer/hooks/useProvider'
import { ipcApi } from '@renderer/ipc'
import { oauthCardClasses } from '@renderer/pages/settings/ProviderSettings/primitives/ProviderSettingsPrimitives'
import { oauthWithCherryIn } from '@renderer/services/oauth'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { cn } from '@renderer/utils/style'
import type { CherryInBalance } from '@shared/ipc/schemas/cherryin'
import { hasApiKeys } from '@shared/utils/provider'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

const logger = loggerService.withContext('CherryInOauth')

interface CherryInOauthProps {
  providerId: string
}

/**
 * Per-gateway presentation: the OAuth/balance/logout flow is one shared
 * implementation; each provider differs only in its hosts and i18n namespace.
 */
const GATEWAY_PRESENTATION = {
  cherryin: {
    oauthServer: 'https://open.cherryin.ai',
    topupUrl: 'https://open.cherryin.ai/console/topup',
    i18nNs: 'cherryIn'
  },
  xuelang: {
    oauthServer: 'https://api.xuelanglm.com',
    topupUrl: 'https://api.xuelanglm.com/console/topup',
    i18nNs: 'xuelang'
  }
} as const

type GatewayPresentationKey = keyof typeof GATEWAY_PRESENTATION

const isGatewayPresentationKey = (value: string): value is GatewayPresentationKey => value in GATEWAY_PRESENTATION

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-'
  }

  return `$${value.toFixed(2)}`
}

const CherryInOauth: FC<CherryInOauthProps> = ({ providerId }) => {
  const { provider, updateProvider, addApiKey, deleteApiKey } = useProvider(providerId)
  const { t } = useTranslation()

  const gateway: GatewayPresentationKey =
    provider && isGatewayPresentationKey(provider.id) && GATEWAY_PRESENTATION[provider.id]
      ? (provider.id)
      : 'cherryin'
  const { oauthServer, topupUrl, i18nNs } = GATEWAY_PRESENTATION[gateway]

  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [balanceInfo, setBalanceInfo] = useState<CherryInBalance | null>(null)
  const [oauthTokenOverride, setOauthTokenOverride] = useState<boolean | null>(null)
  // `oauth.has_token` returns only a boolean — the access/refresh tokens stay in
  // the main process and never reach the renderer (null = status not loaded yet).
  const [remoteHasOAuthToken, setRemoteHasOAuthToken] = useState<boolean | null>(null)
  const topupInProgressRef = useRef(false)

  const refreshHasToken = useCallback(async () => {
    try {
      setRemoteHasOAuthToken(await ipcApi.request('oauth.has_token', { providerId }))
    } catch (error) {
      logger.warn('Failed to check gateway OAuth token status:', error as Error)
      setRemoteHasOAuthToken(false)
    }
  }, [providerId])

  useEffect(() => {
    void refreshHasToken()
  }, [refreshHasToken])

  const hasKeys = provider ? hasApiKeys(provider) : false
  const hasOAuthToken = oauthTokenOverride ?? remoteHasOAuthToken ?? false
  const isOAuthLoggedIn = hasKeys && hasOAuthToken

  const fetchData = useCallback(async () => {
    setIsLoadingData(true)
    try {
      const balance = await ipcApi.request('cherryin.get_balance', { apiHost: oauthServer, providerId: gateway })
      setBalanceInfo(balance)
    } catch (error) {
      logger.warn('Failed to fetch balance:', error as Error)
      setBalanceInfo(null)
    } finally {
      setIsLoadingData(false)
    }
  }, [gateway, oauthServer])

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

  // Top-up happens in the system browser (see WindowManager.setWindowOpenHandler),
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

  const handleOAuthLogin = useCallback(async () => {
    try {
      await oauthWithCherryIn(
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
        {
          oauthServer,
          providerId: gateway
        }
      )
    } catch (error) {
      logger.error('OAuth error:', error as Error)
      toast.error(t('settings.provider.oauth.error'))
    }
  }, [addApiKey, fetchData, gateway, oauthServer, refreshHasToken, t, updateProvider])

  const handleLogout = useCallback(async () => {
    const confirmed = await popup.confirm({
      title: t('settings.provider.oauth.logout'),
      content: t('settings.provider.oauth.logout_confirm'),
      centered: true
    })
    if (!confirmed) return

    setIsLoggingOut(true)

    try {
      await ipcApi.request('cherryin.logout', { apiHost: oauthServer, providerId: gateway })
      setOauthTokenOverride(false)
      setBalanceInfo(null)

      void refreshHasToken()

      const oauthKeys = provider?.apiKeys.filter((key) => key.label === 'OAuth') ?? []
      const deleteResults = await Promise.allSettled(oauthKeys.map((key) => deleteApiKey(key.id)))
      const rejectedDeletes = deleteResults.filter((result) => result.status === 'rejected')
      if (rejectedDeletes.length > 0) {
        logger.warn(`Failed to delete ${rejectedDeletes.length} gateway OAuth key(s) after logout`)
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
  }, [deleteApiKey, gateway, oauthServer, provider?.apiKeys, refreshHasToken, t])

  const handleTopup = useCallback(() => {
    topupInProgressRef.current = true
    window.open(topupUrl, '_blank')
  }, [topupUrl])

  if (!provider) {
    return null
  }

  if (remoteHasOAuthToken === null && hasKeys) {
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
    return (
      <div className={oauthCardClasses.container}>
        <div className={oauthCardClasses.shell}>
          <div className={oauthCardClasses.loggedInRow}>
            <div className={oauthCardClasses.profileMeta}>
              <ProviderAvatar gateway={gateway} />
              <div className={oauthCardClasses.nameBlock}>
                <div className={oauthCardClasses.loggedInName}>
                  {t(`settings.provider.oauth.${i18nNs}.not_logged_in`)}
                </div>
                <div className={cn(oauthCardClasses.loggedInEmail, 'text-muted-foreground')}>
                  {t(`settings.provider.oauth.${i18nNs}.tagline`)}
                </div>
              </div>
            </div>
            <Button variant="emphasis" onClick={handleOAuthLogin}>
              {t(`settings.provider.oauth.${i18nNs}.login_button`)}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const profileName =
    balanceInfo?.profile?.displayName || balanceInfo?.profile?.username || balanceInfo?.profile?.email || provider.name
  const profileEmail = balanceInfo?.profile?.email || t(`settings.provider.oauth.${i18nNs}.logged_in`)
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
            <Button
              className={cn(oauthCardClasses.topupPrimaryButton, 'h-7 px-2.5 py-0')}
              onClick={handleTopup}
              size="sm"
              variant="default">
              {t('settings.provider.oauth.topup')}
            </Button>
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
            i18nKey={`settings.provider.oauth.${i18nNs}.service_attribution`}
            components={{
              link: (
                <a
                  key="gateway-service-link"
                  className={cn(oauthCardClasses.serviceLink, 'text-muted-foreground')}
                  href={oauthServer}
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

const ProviderAvatar: FC<{ gateway: GatewayPresentationKey }> = ({ gateway }) => {
  if (gateway === 'xuelang') {
    return <Xuelang.Avatar shape="circle" size={40} />
  }
  return <Cherryin.Avatar shape="circle" size={40} />
}

export default CherryInOauth
