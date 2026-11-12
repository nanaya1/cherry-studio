import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type * as z from 'zod'

import { Button } from '@cherrystudio/ui'
// 停用弹窗式审核，审核内容改为 Agent 消息流内的文档与选择。
import { ipcApi } from '@renderer/ipc'
import type { industrialVideoReviewDocumentsSchema } from '@shared/ipc/schemas/industrialVideo'

// MEA:industrial-video 专用路径改用服务端工作台（IndustrialVideoWorkbench），不再本地脚本/分镜确认面板。
// 保留 DedicatedIndustrialVideoReview 组件文件供回滚：取消注释下面两行即可恢复原本地审核。
// import DedicatedIndustrialVideoReview from './DedicatedIndustrialVideoReview'
import IndustrialVideoWorkbench from './IndustrialVideoWorkbench'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

type ReviewSnapshot = z.infer<typeof industrialVideoReviewDocumentsSchema>

// export default function IndustrialVideoTaskPanel({ sessionId }: { sessionId: string }) {
// export default function IndustrialVideoTaskPanel({ sessionId }: { sessionId: string; dedicated?: boolean }) {
export default function IndustrialVideoTaskPanel({ sessionId, dedicated }: { sessionId: string; dedicated?: boolean }) {
  const production = useIndustrialVideoProduction(sessionId)
  const { refresh } = production

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(() => void poll(), 3000)
    }
    // MEA:industrial-video Agent 停止后仍对账，也持续发现尚未出现的制作记录。
    timer = setTimeout(() => void poll(), 3000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refresh])

  // MEA:industrial-video 仅专用工作台启用独立审核，普通 Agent 保留原生选择流程。
  // 回滚：将下行替换为 `return <DedicatedIndustrialVideoReview sessionId={sessionId} production={production} />`
  if (dedicated) return <IndustrialVideoWorkbench sessionId={sessionId} production={production} />

  return (
    <TaskReview key={`${sessionId}:${production.record?.run ?? ''}`} sessionId={sessionId} production={production} />
  )
}

function TaskReview({
  sessionId,
  production
}: {
  sessionId: string
  production: ReturnType<typeof useIndustrialVideoProduction>
}) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null)
  const [allowed, setAllowed] = useState(false)
  const [blockers, setBlockers] = useState<unknown[]>([])
  const [estimate, setEstimate] = useState<Record<string, unknown> | null>(null)
  const [settingsVersion, setSettingsVersion] = useState<number | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // const [actionSettled, setActionSettled] = useState(0)
  const [previewUrl, setPreviewUrl] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const record = production.record
  const refresh = production.refresh
  const run = record?.run
  const progress = production.job?.progress as Record<string, unknown> | undefined
  const finalPath = typeof progress?.final === 'string' ? progress.final : ''
  // const jobError = typeof production.job?.error === 'string' ? production.job.error : ''
  const jobError = production.jobError
  const pending = Boolean(record?.unknownSubmissions.length)
  const reviewDisabled = busy || pending || !run || Boolean(production.error)

  const invalidate = useCallback(() => {
    setSnapshot(null)
    setAllowed(false)
    setBlockers([])
    setEstimate(null)
    setSettingsVersion(undefined)
  }, [])
  const execute = useCallback(
    async (action: () => Promise<void>, reviewAction = false) => {
      if (locked.current) return false
      locked.current = true
      setBusy(true)
      setError('')
      try {
        await action()
      } catch (cause) {
        if (mounted.current) {
          if (reviewAction) invalidate()
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        return false
      } finally {
        if (mounted.current) {
          await refresh()
          if (mounted.current) setBusy(false)
        }
        locked.current = false
        // if (mounted.current) setActionSettled((value) => value + 1)
      }
      return true
    },
    [invalidate, refresh]
  )

  const loadReviewSnapshot = useCallback(
    () =>
      execute(async () => {
        invalidate()
        const result = await ipcApi.request('industrial_video.review_snapshot_get', {
          sessionId,
          run: run!,
          reviewType: 'script_and_storyboard'
        })
        if (!mounted.current) return
        if (!('script' in result) || !('storyboard' in result))
          throw new Error(t('industrial_video.task.invalid_snapshot'))
        setSnapshot(result as ReviewSnapshot)
        setBlockers(result.remaining_blockers)
      }, true),
    [execute, invalidate, run, sessionId, t]
  )

  return (
    <section
      aria-label={t('industrial_video.task.title')}
      className={`mx-3 space-y-2 overflow-auto text-sm text-card-foreground ${
        snapshot ? 'max-h-80 border-0 bg-transparent p-0' : 'max-h-72 rounded-md border border-border bg-card p-3'
      }`}>
      {!snapshot && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {t('industrial_video.task.title')} · {record?.state ?? t('industrial_video.task.waiting')} {run}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute(async () => {})}>
            {t('industrial_video.task.refresh')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {production.error && (
        <p role="alert" className="text-error">
          {production.error}
        </p>
      )}
      {jobError && (
        <p role="alert" className="whitespace-pre-wrap break-words text-error">
          {jobError}
        </p>
      )}
      {jobError && Boolean(production.job?.log_tail) && (
        <details className="text-xs">
          <summary>{t('error.detail')}</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {Array.isArray(production.job?.log_tail)
              ? production.job?.log_tail.filter((line): line is string => typeof line === 'string').join('\n')
              : typeof production.job?.log_tail === 'string'
                ? production.job?.log_tail
                : ''}
          </pre>
        </details>
      )}
      {pending && <p role="alert">{t('industrial_video.task.pending')}</p>}
      {production.job && !snapshot && <p role="status">{String(production.job.status ?? record?.state ?? '')}</p>}
      {!snapshot && (
        <Button
          size="sm"
          variant="outline"
          disabled={reviewDisabled || allowed}
          onClick={() => void loadReviewSnapshot()}>
          {t('industrial_video.task.read')}
        </Button>
      )}
      {snapshot && (
        <p role="status" className="text-muted-foreground">
          {t('industrial_video.task.version', { version: snapshot.review_version })} · 请在 Agent
          的“需要你的选择”中完成审核。
        </p>
      )}
      {blockers.length > 0 && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap">{JSON.stringify(blockers, null, 2)}</pre>
      )}
      {estimate && (
        <>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap">{JSON.stringify(estimate, null, 2)}</pre>
          <Button
            size="sm"
            disabled={reviewDisabled || !allowed}
            onClick={() =>
              void execute(async () => {
                setEstimate(null)
                setAllowed(false)
                await ipcApi.request('industrial_video.video_start', {
                  sessionId,
                  run: run!,
                  ...(settingsVersion === undefined ? {} : { expectedSettingsVersion: settingsVersion })
                })
              }, true)
            }>
            {t('industrial_video.task.confirm_cost')}
          </Button>
        </>
      )}
      <p className="text-muted-foreground">{t('industrial_video.task.review_only')}</p>
      {finalPath && (
        <>
          <p className="break-all">{finalPath}</p>
          {progress?.final_stale === true && <p>{t('industrial_video.task.stale')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !run}
              onClick={() =>
                void execute(async () => {
                  setPreviewUrl('')
                  const result = await ipcApi.request('industrial_video.preview_create', { sessionId, run: run! })
                  if (!mounted.current) return
                  if (typeof result.preview_url !== 'string' || !/^https?:\/\//i.test(result.preview_url))
                    throw new Error(t('industrial_video.task.invalid_preview'))
                  setPreviewUrl(result.preview_url)
                })
              }>
              {t('industrial_video.task.preview')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !run}
              onClick={() =>
                void execute(async () => {
                  const result = await ipcApi.request('industrial_video.download_artifact', {
                    sessionId,
                    run: run!,
                    path: finalPath
                  })
                  if (mounted.current) setSavedPath(result.filePath)
                })
              }>
              {t('industrial_video.task.download')}
            </Button>
          </div>
        </>
      )}
      {previewUrl && (
        <a className="text-link" href={previewUrl} target="_blank" rel="noopener noreferrer">
          {t('industrial_video.task.open_preview')}
        </a>
      )}
      {savedPath && <p className="break-all">{t('industrial_video.task.saved', { path: savedPath })}</p>}
    </section>
  )
}
