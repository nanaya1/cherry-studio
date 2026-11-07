// import { useCallback, useEffect, useRef, useState } from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

// import { usePersistCache } from '@renderer/data/hooks/useCache'
import { cacheService } from '@data/CacheService'
import { ipcApi } from '@renderer/ipc'
import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

export function useIndustrialVideoProduction(sessionId?: string) {
  const [record, setRecord] = useState<IndustrialVideoProductionRecord | null>(null)
  const [job, setJob] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const observedJob = useRef('')
  // const [preparation] = usePersistCache(`industrial_video.preparation.${sessionId ?? ''}`)
  // 未创建任务时不读取或订阅空ID缓存，避免默认值警告刷屏。
  const getPreparation = useCallback(
    () => (sessionId ? cacheService.getPersist(`industrial_video.preparation.${sessionId}`) : null),
    [sessionId]
  )
  const preparation = useSyncExternalStore(
    useCallback(
      (onChange) =>
        sessionId ? cacheService.subscribe(`industrial_video.preparation.${sessionId}`, onChange) : () => {},
      [sessionId]
    ),
    getPreparation,
    getPreparation
  )
  const preparationStage = preparation?.stage

  const refresh = useCallback(async () => {
    if (!sessionId) return
    const current = ++epoch.current
    try {
      const saved = await ipcApi.request('industrial_video.get_records', { sessionId })
      if (current !== epoch.current) return
      setRecord(saved as IndustrialVideoProductionRecord | null)
      // setJob(null)
      // 同一任务轮询保留已确认进度，避免预览下载与播放器被每次对账中断。
      const identity = `${sessionId}:${saved?.run ?? ''}:${saved?.jobId ?? ''}`
      if (observedJob.current !== identity) {
        observedJob.current = identity
        setJob(null)
      }
      if (saved?.jobId) {
        const latest = await ipcApi.request('industrial_video.job_get', { sessionId, jobId: saved.jobId })
        if (current !== epoch.current) return
        // job_get 对账会更新主进程记录，不能继续展示轮询前的快照。
        const reconciled = await ipcApi.request('industrial_video.get_records', { sessionId })
        if (current !== epoch.current) return
        setRecord(reconciled as IndustrialVideoProductionRecord | null)
        setJob(reconciled?.jobId === saved.jobId ? latest : null)
      }
      setError('')
    } catch (cause) {
      if (current === epoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    epoch.current += 1
    setRecord(null)
    setJob(null)
    setError('')
    void refresh()
    return () => {
      epoch.current += 1
    }
  }, [refresh])

  useEffect(() => {
    if (preparationStage === 'submitted') void refresh()
  }, [preparationStage, refresh])

  // job_get 成功并不表示任务成功；业务失败原因与轮询请求错误分开保留。
  const jobMatchesRun = !job?.run || job.run === record?.run
  const rawJobError = jobMatchesRun ? job?.error : undefined
  const detail = rawJobError && typeof rawJobError === 'object' ? (rawJobError as Record<string, unknown>) : null
  const jobError =
    typeof rawJobError === 'string'
      ? rawJobError
      : detail
        ? [detail.code, detail.message, detail.detail, detail.hint]
            .filter((value) => typeof value === 'string' && value.trim())
            .join(' · ')
        : ''

  // return { record, job, error, refresh }
  return { record, job, error, jobError, refresh }
}
