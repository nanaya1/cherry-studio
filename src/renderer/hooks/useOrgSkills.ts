import { useCallback, useEffect, useRef, useState } from 'react'

import { loggerService } from '@logger'
import { useInvalidateSkills } from '@renderer/hooks/useSkills'
import { ipcApi } from '@renderer/ipc'

const logger = loggerService.withContext('useOrgSkills')

// [enterprise] T0 企业技能目录 hook：登录态下拉取企业下发的技能列表 + 安装
export interface OrgSkillFacet {
  code: string
  name: string
}

export interface OrgSkillItem {
  slug: string
  name: string
  description: string
  version: string
  contentHash: string
  downloadUrl: string
  iconUrl?: string | null
  categories?: OrgSkillFacet[]
  tags?: OrgSkillFacet[]
}

function orgSkillErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error')
}

export function useOrgSkills(enabled: boolean) {
  const [skills, setSkills] = useState<OrgSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(() => new Set())
  // [enterprise] 本地已安装的 slug（对话框标记「已安装」状态）
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(() => new Set())
  // [enterprise] C2：本地已安装但企业已停用/下架的 slug（提示"可删除"，不注入新会话）
  const [disabledSlugs, setDisabledSlugs] = useState<string[]>([])
  const requestRef = useRef(0)
  const invalidate = useInvalidateSkills()

  const refetch = useCallback(async () => {
    const requestId = ++requestRef.current
    if (!enabled) {
      setSkills([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // [enterprise] 目录响应携带 installedSlugs（原解构注释保留）
      // const { skills: list } = await ipcApi.request('enterprise.skills.list')
      // force: 用户主动刷新必须穿透主进程目录 TTL 缓存（管理台启停后立即生效）
      const { skills: list, installedSlugs: installed } = await ipcApi.request('enterprise.skills.list', {
        force: true
      })
      if (requestId !== requestRef.current) return
      setSkills(list)
      setInstalledSlugs(new Set(installed))
      // [enterprise] C2：并行查询停用列表（查询失败不影响目录展示）
      try {
        const { disabled } = await ipcApi.request('enterprise.skills.listDisabled')
        if (requestId !== requestRef.current) return
        setDisabledSlugs(disabled)
      } catch {
        if (requestId === requestRef.current) setDisabledSlugs([])
      }
    } catch (cause) {
      if (requestId !== requestRef.current) return
      const message = orgSkillErrorMessage(cause)
      logger.warn('Failed to list org skills', { error: message })
      setSkills([])
      setError(message)
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const install = useCallback(
    async (slug: string): Promise<boolean> => {
      setInstalling((current) => new Set(current).add(slug))
      try {
        await ipcApi.request('enterprise.skills.install', { slug })
        // [enterprise] 安装成功即时标记「已安装」（不等 refetch）
        setInstalledSlugs((current) => new Set(current).add(slug))
        // 刷新 SQLite 列表与文件系统增强目录（useInvalidateSkills 同时覆盖两者）
        await invalidate()
        return true
      } catch (cause) {
        const message = orgSkillErrorMessage(cause)
        logger.error('Failed to install org skill', { slug, error: message })
        throw new Error(message)
      } finally {
        setInstalling((current) => {
          const next = new Set(current)
          next.delete(slug)
          return next
        })
      }
    },
    [invalidate]
  )

  // [enterprise] C4：删除（卸载）企业技能并上报 deleted 事件
  const remove = useCallback(
    async (slug: string): Promise<boolean> => {
      try {
        await ipcApi.request('enterprise.skills.reportDeleted', { slug })
        // [enterprise] 卸载成功即时移除「已安装」标记
        setInstalledSlugs((current) => {
          const next = new Set(current)
          next.delete(slug)
          return next
        })
        await invalidate()
        return true
      } catch (cause) {
        const message = orgSkillErrorMessage(cause)
        logger.error('Failed to remove org skill', { slug, error: message })
        throw new Error(message)
      }
    },
    [invalidate]
  )

  return { skills, loading, error, install, installing, refetch, disabledSlugs, installedSlugs, remove }
}
