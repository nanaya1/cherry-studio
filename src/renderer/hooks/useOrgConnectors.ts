import { useCallback, useEffect, useRef, useState } from 'react'

import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'

const logger = loggerService.withContext('useOrgConnectors')

// [enterprise] T0 组织连接器 hook：登录态下拉取企业下发的连接器列表 + 安装
export interface OrgConnectorItem {
  slug: string
  name: string
  description: string
  // 目录 v2 与管理台快速创建对齐：stdio/sse/streamableHttp（旧服务端恒为 sse）
  type: 'stdio' | 'sse' | 'streamableHttp'
  baseUrl: string
  config: Record<string, unknown>
}

function orgConnectorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error')
}

export function useOrgConnectors(enabled: boolean) {
  const [connectors, setConnectors] = useState<OrgConnectorItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // [enterprise] available：目录服务是否实际可达（请求成功即置 true，空数组也成功）
  const [available, setAvailable] = useState(false)
  const [installing, setInstalling] = useState<Set<string>>(() => new Set())
  const requestRef = useRef(0)
  // [enterprise] 追踪是否已成功加载过目录，用于区分「首次失败」与「刷新失败」
  const availableRef = useRef(false)

  const refetch = useCallback(async () => {
    const requestId = ++requestRef.current
    if (!enabled) {
      // 登出/未启用：重置目录与可用性，清空错误
      setConnectors([])
      setAvailable(false)
      availableRef.current = false
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { connectors: list } = await ipcApi.request('enterprise.connectors.list')
      if (requestId !== requestRef.current) return
      setConnectors(list)
      // 目录实际请求成功即标记可用（空数组也成功）
      availableRef.current = true
      setAvailable(true)
    } catch (cause) {
      if (requestId !== requestRef.current) return
      const message = orgConnectorErrorMessage(cause)
      logger.warn('Failed to list org connectors', { error: message })
      // 原逻辑：失败即清空列表 setConnectors([])
      // 新逻辑：错误照常记录；仅「从未成功过」时保持不可用，刷新失败保留列表与 available=true
      if (!availableRef.current) {
        availableRef.current = false
        setAvailable(false)
      }
      setError(message)
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // [enterprise] 卸载时使在途请求失效，防止旧请求回写到已卸载组件
  useEffect(() => {
    const requests = requestRef
    return () => {
      requests.current++
    }
  }, [])

  const install = useCallback(async (slug: string): Promise<void> => {
    setInstalling((current) => new Set(current).add(slug))
    try {
      await ipcApi.request('enterprise.connectors.install', { slug })
    } finally {
      setInstalling((current) => {
        const next = new Set(current)
        next.delete(slug)
        return next
      })
    }
  }, [])

  return { connectors, loading, error, available, install, installing, refetch }
}
