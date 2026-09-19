import { useCallback, useEffect, useState } from 'react'

import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { useInvalidateSkills } from '@renderer/hooks/useSkills'

const logger = loggerService.withContext('useOrgSkills')

// [enterprise] T0 企业技能目录 hook：登录态下拉取企业下发的技能列表 + 安装
export interface OrgSkillItem {
  slug: string
  name: string
  description: string
  version: string
  contentHash: string
  downloadUrl: string
}

function orgSkillErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error')
}

export function useOrgSkills(enabled: boolean) {
  const [skills, setSkills] = useState<OrgSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(() => new Set())
  // [enterprise] C2：本地已安装但企业已停用/下架的 slug（提示"可删除"，不注入新会话）
  const [disabledSlugs, setDisabledSlugs] = useState<string[]>([])
  const invalidate = useInvalidateSkills()

  const refetch = useCallback(async () => {
    if (!enabled) {
      setSkills([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { skills: list } = await ipcApi.request('enterprise.skills.list')
      setSkills(list)
      // [enterprise] C2：并行查询停用列表（查询失败不影响目录展示）
      try {
        const { disabled } = await ipcApi.request('enterprise.skills.listDisabled')
        setDisabledSlugs(disabled)
      } catch {
        setDisabledSlugs([])
      }
    } catch (cause) {
      const message = orgSkillErrorMessage(cause)
      logger.warn('Failed to list org skills', { error: message })
      setSkills([])
      setError(message)
    } finally {
      setLoading(false)
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
  const remove = useCallback(async (slug: string): Promise<boolean> => {
    try {
      await ipcApi.request('enterprise.skills.reportDeleted', { slug })
      await invalidate()
      return true
    } catch (cause) {
      const message = orgSkillErrorMessage(cause)
      logger.error('Failed to remove org skill', { slug, error: message })
      throw new Error(message)
    }
  }, [invalidate])

  return { skills, loading, error, install, installing, refetch, disabledSlugs, remove }
}
