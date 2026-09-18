import { useCallback, useEffect, useRef, useState } from 'react'

import { ipcApi, useIpcOn } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

type OrgStatusLoadState = 'error' | 'loading' | 'ready'

type OrgSessionAction = 'login' | 'logout'

// [enterprise] T0 企业登录会话 hook（参考 useCherryAccountSession 简化版）
export function useOrgAccountSession(enabled = true) {
  const [status, setStatus] = useState<EnterpriseStatus | null>(null)
  const [loadState, setLoadState] = useState<OrgStatusLoadState>('loading')
  const [pendingAction, setPendingAction] = useState<OrgSessionAction | null>(null)
  const requestRef = useRef(0)

  const applyStatus = useCallback((next: EnterpriseStatus) => {
    setStatus(next)
    setLoadState('ready')
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
    async (action: OrgSessionAction) => {
      const requestId = ++requestRef.current
      setPendingAction(action)
      try {
        if (action === 'login') {
          // 登录返回 authorizationUrl；状态由主进程在回调完成后广播
          await ipcApi.request('enterprise.login.start')
        } else {
          await ipcApi.request('enterprise.session.logout')
          applyStatus(await ipcApi.request('enterprise.status.get'))
        }
      } catch {
        if (requestId !== requestRef.current) return
        toast.error(action === 'login' ? '企业服务登录失败' : '退出登录失败')
      } finally {
        setPendingAction((current) => (current === action ? null : current))
      }
    },
    [applyStatus]
  )

  return {
    status,
    loadState,
    reload,
    login: useCallback(() => runAction('login'), [runAction]),
    logout: useCallback(() => runAction('logout'), [runAction]),
    isLoggingIn: pendingAction === 'login',
    isLoggingOut: pendingAction === 'logout'
  }
}
