import { loggerService } from '@logger'
import i18n, { getLanguageCode } from '@renderer/i18n/resolver'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { openExternalWebsite } from '@renderer/services/website'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

const logger = loggerService.withContext('oauth')

const SILICON_CLIENT_ID = 'SFaJLLq0y6CAMoyDm81aMu'
const PPIO_CLIENT_ID = '37d0828c96b34936a600b62c'
const PPIO_APP_SECRET = import.meta.env.RENDERER_VITE_PPIO_APP_SECRET || ''

export const oauthWithSiliconFlow = async (setKey) => {
  const authUrl = `https://account.siliconflow.cn/oauth?client_id=${SILICON_CLIENT_ID}`

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  const messageHandler = (event) => {
    if (event.data.length > 0 && event.data[0]['secretKey'] !== undefined) {
      setKey(event.data[0]['secretKey'])
      popup?.close()
      window.removeEventListener('message', messageHandler)
    }
  }

  window.removeEventListener('message', messageHandler)
  window.addEventListener('message', messageHandler)
}

export const oauthWithAihubmix = async (setKey) => {
  const authUrl = ` https://console.inferera.com/token?client_id=cherry_studio_oauth&lang=${await getLanguageCode()}&aff=SJyh`

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  const messageHandler = async (event) => {
    const data = event.data

    if (data && data.key === 'cherry_studio_oauth_callback') {
      const { iv, encryptedData } = data.data

      try {
        const secret = import.meta.env.RENDERER_VITE_AIHUBMIX_SECRET || ''
        const decryptedData: any = await window.api.aes.decrypt(encryptedData, iv, secret)
        const { api_keys } = JSON.parse(decryptedData)
        if (api_keys && api_keys.length > 0) {
          setKey(api_keys[0].value)
          popup?.close()
          window.removeEventListener('message', messageHandler)
        }
      } catch (error) {
        logger.error('[oauthWithAihubmix] error', error as Error)
        popup?.close()
        toast.error(i18n.t('settings.provider.oauth.error'))
      }
    }
  }

  window.removeEventListener('message', messageHandler)
  window.addEventListener('message', messageHandler)
}

export const oauthWithPPIO = async (setKey) => {
  const redirectUri = 'meacowork://'
  const authUrl = `https://ppio.com/oauth/authorize?invited_by=JYT9GD&client_id=${PPIO_CLIENT_ID}&scope=api%20openid&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`

  void openExternalWebsite(authUrl)

  if (!setKey) {
    logger.debug('[PPIO OAuth] No setKey callback provided, returning early')
    return
  }

  logger.debug('[PPIO OAuth] Setting up protocol listener')

  return new Promise<string>((resolve, reject) => {
    const removeListener = ipcApi.on('navigation.protocol_data', async (data) => {
      try {
        const url = new URL(data.url)
        const params = new URLSearchParams(url.search)
        const code = params.get('code')

        if (!code) {
          reject(new Error('No authorization code received'))
          return
        }

        if (!PPIO_APP_SECRET) {
          reject(
            new Error('PPIO_APP_SECRET not configured. Please set RENDERER_VITE_PPIO_APP_SECRET environment variable.')
          )
          return
        }
        const formData = new URLSearchParams({
          client_id: PPIO_CLIENT_ID,
          client_secret: PPIO_APP_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
        const tokenResponse = await fetch('https://ppio.com/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: formData.toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          logger.error(`[PPIO OAuth] Token exchange failed: ${tokenResponse.status} ${errorText}`)
          throw new Error(`Failed to exchange code for token: ${tokenResponse.status} ${errorText}`)
        }

        const tokenData = await tokenResponse.json()
        const accessToken = tokenData.access_token

        if (accessToken) {
          setKey(accessToken)
          resolve(accessToken)
        } else {
          reject(new Error('No access token received'))
        }
      } catch (error) {
        logger.error('[PPIO OAuth] Error processing callback:', error as Error)
        reject(error)
      } finally {
        removeListener()
      }
    })
  })
}

export const oauthWith302AI = async (setKey) => {
  const authUrl = 'https://dash.302.ai/sso/login?app=cherry-ai.com&name=Cherry%20Studio'

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  const messageHandler = (event) => {
    if (event.data && event.data.data.apikey !== undefined) {
      setKey(event.data.data.apikey)
      popup?.close()
      window.removeEventListener('message', messageHandler)
    }
  }

  window.removeEventListener('message', messageHandler)
  window.addEventListener('message', messageHandler)
}

export const oauthWithAiOnly = async (setKey) => {
  const authUrl = `https://maas.aiionly.com/login?inviteCode=1755481173663DrZBBOC0&cherryCode=01`

  const popup = window.open(
    authUrl,
    'login',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  const messageHandler = (event) => {
    if (event.data.length > 0 && event.data[0]['secretKey'] !== undefined) {
      setKey(event.data[0]['secretKey'])
      popup?.close()
      window.removeEventListener('message', messageHandler)
    }
  }

  window.removeEventListener('message', messageHandler)
  window.addEventListener('message', messageHandler)
}

export interface NewApiOAuthConfig {
  oauthServer: string
  apiHost?: string
  requestId?: string
  providerId?: 'cherryin' | 'xuelang'
  signal?: AbortSignal
}

export const provisionOAuthApiKeys = async (providerId: 'cherryin' | 'xuelang'): Promise<string> => {
  return ipcApi.request('oauth.provision_api_keys', { providerId })
}

/** Gateway authorization is handled by the provider's registered main-process runtime. */
export const oauthWithCherryIn = async (
  setKey: (key: string) => void | Promise<void>,
  config: NewApiOAuthConfig
): Promise<string> => {
  const providerId = config.providerId ?? SystemProviderIds.cherryin
  if (providerId === SystemProviderIds.cherryin) {
    const result = await ipcApi.request('cherryin.sign_in', {
      requestId: config.requestId ?? crypto.randomUUID(),
      oauthServer: config.oauthServer,
      apiHost: config.apiHost
    })
    if (!result.apiKeys) throw new Error('No API keys received')
    await setKey(result.apiKeys)
    return result.apiKeys
  }

  // MEA:xuelang-oauth-lifecycle 全程 watchdog 不依赖 start、浏览器或保存是否返回。
  /* 原流程先等待启动，再创建结果 Promise；现先启动全程超时与取消监听。
  const { authUrl, state } = await ipcApi.request('oauth.start_deep_link_flow', {
    providerId, oauthServer: config.oauthServer, apiHost: config.apiHost
  })
  */
  return new Promise<string>((resolve, reject) => {
    const requestId = config.requestId ?? crypto.randomUUID()
    const deadline = Date.now() + 10 * 60 * 1000
    let settled = false
    let state: string | undefined
    let removeListener = (): void => {}
    const cancelBackend = () => {
      void ipcApi.request('oauth.cancel_sign_in', { providerId, requestId }).catch((error) => {
        logger.warn('Failed to cancel Xuelang OAuth attempt', error as Error)
      })
    }
    const finish = (error?: unknown, key?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeListener()
      config.signal?.removeEventListener('abort', abort)
      if (error) {
        cancelBackend()
        reject(error)
      } else resolve(key!)
    }
    const check = () => {
      if (!settled && Date.now() >= deadline) finish(new Error('OAuth flow timed out'))
      return !settled
    }
    const abort = () => finish(Object.assign(new Error('OAuth flow cancelled'), { code: 'OAUTH_SIGN_IN_CANCELLED' }))
    const timer = setTimeout(() => finish(new Error('OAuth flow timed out')), 10 * 60 * 1000)
    config.signal?.addEventListener('abort', abort, { once: true })
    if (config.signal?.aborted) {
      abort()
      return
    }
    void (async () => {
      try {
        const flow = await ipcApi.request('oauth.start_deep_link_flow', {
          providerId,
          requestId,
          oauthServer: config.oauthServer,
          apiHost: config.apiHost
        })
        if (!check()) {
          cancelBackend()
          return
        }
        state = flow.state
        removeListener = ipcApi.on('oauth.deep_link_result', async (result) => {
          /* 原回调仅匹配 state 并立即清理超时；现匹配尝试且覆盖保存阶段。
          if (result.state !== state) return
          cleanup()
          */
          if (result.state !== state || result.requestId !== requestId || !check()) return
          removeListener()
          if ('error' in result) {
            finish(Object.assign(new Error(result.error), { code: result.code }))
            return
          }
          if (!result.apiKeys) {
            finish(new Error('No API keys received'))
            return
          }
          try {
            await setKey(result.apiKeys)
            // 原保存完成立即 resolve(result.apiKeys)；现保留 watchdog 并确认尝试未失效。
            if (check()) finish(undefined, result.apiKeys)
          } catch (error) {
            finish(error)
          }
        })
        /* 原浏览器打开失败只清理本地监听；现 finish 同时取消后端尝试。
        await openExternalWebsite(authUrl)
        // catch: cleanupFlow(); return Promise.reject(error)
        */
        await openExternalWebsite(flow.authUrl)
        check()
      } catch (error) {
        finish(error)
      }
    })()
  })
}

export const oauthWithTokenDance = async (setKey) => {
  try {
    const apiKey = await ipcApi.request('oauth.tokendance.authorize_api_key')
    setKey(apiKey)
  } catch (error) {
    logger.error('[oauthWithTokenDance] error', error as Error)
    toast.error(i18n.t('settings.provider.oauth.error'))
  }
}

export const providerCharge = async (provider: string) => {
  const lang = await getLanguageCode()
  const chargeUrlMap = {
    silicon: {
      url: 'https://cloud.siliconflow.cn/expensebill'
    },
    aihubmix: {
      url: `https://console.inferera.com/topup?client_id=cherry_studio_oauth&lang=${lang}&aff=SJyh`
    },
    ppio: {
      url: 'https://ppio.com/user/register?invited_by=JYT9GD&utm_source=github_cherry-studio&redirect=/billing'
    },
    '302ai': {
      url: 'https://dash.302.ai/charge'
    },
    aionly: {
      url: `https://maas.aiionly.com/recharge`
    },
    tokendance: {
      url: 'https://tokendance.space/credits'
    }
  }

  const { url } = chargeUrlMap[provider]

  await openExternalWebsite(url)
}

export const providerBills = async (provider: string) => {
  const lang = await getLanguageCode()
  const billsUrlMap = {
    silicon: {
      url: 'https://cloud.siliconflow.cn/bills'
    },
    aihubmix: {
      url: `https://console.inferera.com/statistics?client_id=cherry_studio_oauth&lang=${lang}&aff=SJyh`
    },
    ppio: {
      url: 'https://ppio.com/user/register?invited_by=JYT9GD&utm_source=github_cherry-studio&redirect=/billing/billing-details'
    },
    '302ai': {
      url: 'https://dash.302.ai/charge'
    },
    aionly: {
      url: `https://maas.aiionly.com/billManagement`
    },
    tokendance: {
      url: 'https://tokendance.space/activity/requests'
    }
  }

  const { url } = billsUrlMap[provider]

  await openExternalWebsite(url)
}
