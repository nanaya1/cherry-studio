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
import { registerResumeStages } from './industrialVideoWorkbenchResumeBridge'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

export function IndustrialVideoMessageReview({
  sessionId,
  executing,
  resumeStages,
  sendMessage
}: {
  sessionId: string
  executing: boolean
  resumeStages?: (run: string) => Promise<unknown>
  sendMessage?: (message: { text: string }) => Promise<boolean>
}) {
  const production = useIndustrialVideoProduction(sessionId)
  const run = production.record?.run
  const { refresh } = production
  const executionActive = production.record?.control?.phase === 'active'
  // 注册既有 resumeStages 供工业工作台 webview 受限桥在同 session/run 下回调，不暴露给网页。
  useEffect(() => {
    if (!run || !resumeStages) return
    return registerResumeStages(sessionId, run, resumeStages)
  }, [sessionId, run, resumeStages])
  useEffect(() => {
    // if (!executing) void refresh()
    if (executing) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(() => void poll(), 3000)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [executing, refresh])
  // const [review, setReview] = useState<{ run: string; snapshot: Record<string, unknown> } | null>(null)
  const [review, setReview] = useState<{ sessionId: string; run: string; snapshot: Record<string, unknown> } | null>(
    null
  )
  const [reviewError, setReviewError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setReview(null)
    setReviewError('')
    // if (!run || executing || production.record?.state !== 'storyboard_submitted') return
    if (!run || executing || executionActive || production.record?.state !== 'storyboard_submitted') return
    let active = true
    void ipcApi
      .request('industrial_video.cowork_review_get', { sessionId, run })
      .then((snapshot) => {
        // if (active) setReview({ run, snapshot })
        if (active) setReview({ sessionId, run, snapshot })
      })
      // .catch(() => undefined)
      .catch((cause) => {
        if (active) setReviewError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
    // }, [sessionId, run, executing, production.record?.state])
  }, [sessionId, run, executing, executionActive, production.record?.state, retry])
  // 等消息终态和本轮权限释放后再提供审核，保留轮询以自动恢复。
  if (
    executing ||
    executionActive ||
    production.record?.sessionId !== sessionId ||
    production.record?.state !== 'storyboard_submitted'
  )
    return null
  if (reviewError)
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>审核读取失败：{reviewError}</p>
        <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
          重试读取审核
        </Button>
      </div>
    )
  // if (!review || review.run !== run) return null
  if (!review || review.sessionId !== sessionId || review.run !== run) return null
  return (
    <IndustrialVideoWorkbench
      key={review.snapshot.review_version as string}
      sessionId={sessionId}
      production={production}
      executing={executing}
      resumeStages={resumeStages}
      reviewOutput={review.snapshot}
      sendMessage={sendMessage}
    />
  )
}

type ReviewSnapshot = z.infer<typeof industrialVideoReviewDocumentsSchema>

// export default function IndustrialVideoTaskPanel({ sessionId }: { sessionId: string }) {
// export default function IndustrialVideoTaskPanel({ sessionId }: { sessionId: string; dedicated?: boolean }) {
export default function IndustrialVideoTaskPanel({
  sessionId,
  dedicated,
  resumeStages,
  executing,
  reviewOutput,
  sendMessage
}: {
  sessionId: string
  dedicated?: boolean
  resumeStages?: (run: string) => Promise<unknown>
  executing?: boolean
  reviewOutput?: Record<string, unknown>
  sendMessage?: (message: { text: string }) => Promise<boolean>
}) {
  const production = useIndustrialVideoProduction(sessionId)
  const { refresh } = production
  // 注册既有 resumeStages 供工业工作台 webview 受限桥在同 session/run 下回调，不暴露给网页。
  useEffect(() => {
    const run = production.record?.run
    if (!run || !resumeStages) return
    return registerResumeStages(sessionId, run, resumeStages)
  }, [sessionId, production, resumeStages])

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
  // if (dedicated) return <IndustrialVideoWorkbench sessionId={sessionId} production={production} />
  if (dedicated)
    return (
      <IndustrialVideoWorkbench
        sessionId={sessionId}
        production={production}
        resumeStages={resumeStages}
        executing={executing}
        reviewOutput={reviewOutput}
        sendMessage={sendMessage}
      />
    )

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
