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
  type: 'stdio' | 'sse' | 'streamableHttp' | null
  resourceKey: string
  tenantId: string | null
  iconUrl: string | null
  configurationError: string | null
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
  const [installing, setInstalling] = useState<Set<string>>(() => new Set())
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(() => new Set())
  const requestGeneration = useRef(0)

  const refetch = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (!enabled) {
      setConnectors([])
      setInstalledKeys(new Set())
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // const { connectors: list } = await ipcApi.request('enterprise.connectors.list')
      const { connectors: list, installedKeys: keys } = await ipcApi.request('enterprise.connectors.list_resources')
      if (generation !== requestGeneration.current) return
      setConnectors(list)
      setInstalledKeys(new Set(keys))
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      const message = orgConnectorErrorMessage(cause)
      logger.warn('Failed to list org connectors', { error: message })
      setConnectors([])
      setError(message)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refetch()
    return () => {
      requestGeneration.current += 1
    }
  }, [refetch])

  const install = useCallback(async (slug: string): Promise<void> => {
    setInstalling((current) => new Set(current).add(slug))
    try {
      // await ipcApi.request('enterprise.connectors.install', { slug })
      const generation = requestGeneration.current
      await ipcApi.request('enterprise.connectors.install_resource', { resourceKey: slug })
      if (generation === requestGeneration.current) setInstalledKeys((current) => new Set(current).add(slug))
    } finally {
      setInstalling((current) => {
        const next = new Set(current)
        next.delete(slug)
        return next
      })
    }
  }, [])

  return { connectors, loading, error, install, installing, installedKeys, refetch }
}
