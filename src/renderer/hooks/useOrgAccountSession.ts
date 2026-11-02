import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ipcApi, useIpcOn } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

type OrgStatusLoadState = 'error' | 'loading' | 'ready'

// type OrgSessionAction = 'login' | 'logout'
type OrgSessionAction = 'cancel' | 'login' | 'logout'

// [enterprise] T0 企业登录会话 hook（参考 useCherryAccountSession 简化版）
export function useOrgAccountSession(enabled = true) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<EnterpriseStatus | null>(null)
  const [loadState, setLoadState] = useState<OrgStatusLoadState>('loading')
  const [pendingAction, setPendingAction] = useState<OrgSessionAction | null>(null)
  // [enterprise] C3：登出后 org 技能/连接器标记"组织不可用"（本地保留，重登恢复）
  const [orgUnavailable, setOrgUnavailable] = useState(false)
  const requestRef = useRef(0)
  const statusRef = useRef<EnterpriseStatus | null>(null)
  const actionRef = useRef<{ action: OrgSessionAction; attemptId?: string | null } | null>(null)
  const [loginError, setLoginError] = useState<EnterpriseStatus['loginError']>(null)
  const [loginStartedAt, setLoginStartedAt] = useState<number | null>(null)
  const [waitHintVisible, setWaitHintVisible] = useState(false)

  const applyStatus = useCallback((next: EnterpriseStatus) => {
    statusRef.current = next
    const active = actionRef.current
    if (
      active &&
      (next.phase !== 'authorizing' || active.action === 'login' || active.attemptId !== next.loginAttemptId)
    ) {
      actionRef.current = null
      setPendingAction(null)
    }
    setLoginError(next.loginError ?? null)
    setLoginStartedAt(next.phase === 'authorizing' ? (next.loginStartedAt ?? null) : null)
    setStatus(next)
    setLoadState('ready')
    // [enterprise] C3：登录态变化时同步查询不可用标记（登出置位 / 重登恢复）
    ipcApi
      .request('enterprise.status.orgUnavailable')
      .then((res) => setOrgUnavailable(res.unavailable))
      .catch(() => setOrgUnavailable(false))
  }, [])

  useIpcOn('enterprise.status_changed', (next) => {
    if (!enabled) return
    requestRef.current += 1
    applyStatus(next)
  })

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoadState('loading')
    try {
      const next = await ipcApi.request('enterprise.status.get')
      if (requestId === requestRef.current) applyStatus(next)
    } catch {
      if (requestId === requestRef.current) setLoadState('error')
    }
  }, [applyStatus])

  useEffect(() => {
    if (!enabled) return
    void reload()
    return () => {
      requestRef.current += 1
    }
  }, [enabled, reload])

  const runAction = useCallback(
    async (action: OrgSessionAction, attemptId?: string | null) => {
      if (action === 'cancel') {
        if (!attemptId || statusRef.current?.loginAttemptId !== attemptId || statusRef.current.phase !== 'authorizing')
          return
        if (actionRef.current?.action === 'cancel') return
      } else if (actionRef.current || (action === 'login' && statusRef.current?.phase === 'authorizing')) return
      const active = { action, attemptId }
      actionRef.current = active
      const requestId = ++requestRef.current
      setPendingAction(action)
      if (action === 'login') {
        setLoginError(null)
        setLoginStartedAt(Date.now())
      }
      try {
        if (action === 'login') {
          // 登录返回 authorizationUrl；状态由主进程在回调完成后广播
          await ipcApi.request('enterprise.login.start')
          if (actionRef.current !== active || requestId !== requestRef.current) return
          const next = await ipcApi.request('enterprise.status.get')
          if (actionRef.current === active && requestId === requestRef.current) applyStatus(next)
        } else if (action === 'cancel' && attemptId) {
          // const result = await ipcApi.request('enterprise.login.cancel', { attemptId })
          // if (actionRef.current === active && result.ok && statusRef.current?.loginAttemptId === attemptId) {
          //   applyStatus({
          //     ...statusRef.current,
          //     phase: 'signed-out',
          //     loginAttemptId: null,
          //     loginStartedAt: null,
          //     loginError: null
          //   })
          // }
          // 取消结果不代表会话状态，true/false 均以主进程状态校准。
          await ipcApi.request('enterprise.login.cancel', { attemptId })
          if (
            actionRef.current !== active ||
            requestId !== requestRef.current ||
            statusRef.current?.loginAttemptId !== attemptId
          )
            return
          const next = await ipcApi.request('enterprise.status.get')
          if (
            actionRef.current === active &&
            requestId === requestRef.current &&
            statusRef.current?.loginAttemptId === attemptId
          )
            applyStatus(next)
        } else {
          await ipcApi.request('enterprise.session.logout')
          // applyStatus(await ipcApi.request('enterprise.status.get'))
          const next = await ipcApi.request('enterprise.status.get')
          if (requestId === requestRef.current) applyStatus(next)
        }
      } catch {
        // if (requestId !== requestRef.current) return
        if (actionRef.current !== active) return
        if (action === 'login') {
          setLoginError('failed')
          actionRef.current = null
          setPendingAction(null)
        }
        // 原硬编码：'企业服务登录失败' / '退出登录失败'
        // 原分支：action === 'login' ? 'settings.provider.org_service.login_failed' : 'settings.provider.org_service.logout_failed'
        toast.error(
          t(
            action === 'cancel'
              ? 'settings.provider.org_service.login_cancel_failed'
              : action === 'login'
                ? 'settings.provider.org_service.login_failed'
                : 'settings.provider.org_service.logout_failed'
          )
        )
      } finally {
        // setPendingAction((current) => (current === action ? null : current))
        if (action !== 'login' && actionRef.current === active) {
          actionRef.current = null
          setPendingAction(null)
        }
      }
    },
    [applyStatus, t]
  )

  const isLoggingIn = pendingAction === 'login' || status?.phase === 'authorizing'
  useEffect(() => {
    if (!enabled || !isLoggingIn || loginStartedAt === null) {
      setWaitHintVisible(false)
      return
    }
    const remaining = Math.max(0, loginStartedAt + 60_000 - Date.now())
    setWaitHintVisible(remaining === 0)
    const timer = setTimeout(() => setWaitHintVisible(true), remaining)
    return () => clearTimeout(timer)
  }, [enabled, isLoggingIn, loginStartedAt])

  const attemptId = status?.loginAttemptId
  const authoritativeStartedAt = status?.phase === 'authorizing' ? status.loginStartedAt : null
  useEffect(() => {
    if (!enabled || !attemptId || authoritativeStartedAt == null) return
    const timer = setTimeout(() => void reload(), Math.max(0, authoritativeStartedAt + 10 * 60_000 - Date.now()))
    return () => clearTimeout(timer)
  }, [enabled, attemptId, authoritativeStartedAt, reload])

  const cancelLogin = useCallback(() => runAction('cancel', attemptId), [runAction, attemptId])

  return {
    status,
    cancelLogin,
    isCancellingLogin: pendingAction === 'cancel',
    loginError,
    waitHintVisible,
    loadState,
    reload,
    login: useCallback(() => runAction('login'), [runAction]),
    logout: useCallback(() => runAction('logout'), [runAction]),
    // [enterprise] C3
    orgUnavailable,
    // isLoggingIn: pendingAction === 'login',
    isLoggingIn,
    isLoggingOut: pendingAction === 'logout'
  }
}
