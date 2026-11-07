import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@cherrystudio/ui'
import { ToolDisclosure } from '@renderer/components/chat/messages/tools/shared/ToolDisclosure'
import { ToolResultAttachmentsContext } from '@renderer/components/chat/messages/tools/shared/ToolDisplayNames'
// import { FilePreview } from '@renderer/components/FilePreview'
import { ipcApi } from '@renderer/ipc'
// import { normalizeFilePreviewPath } from '@renderer/utils/filePreview'
import { normalizeMeacoworkToolRuntimeName, toMeacoworkToolRuntimeName } from '@shared/ai/meacoworkTools'

// import { LoaderCircle } from 'lucide-react'
import IndustrialVideoGenerationLoading, { readGenerationProgress } from './IndustrialVideoGenerationLoading'
// import type { AbsoluteFilePath } from '@shared/types/file'
import IndustrialVideoOnlinePreview from './IndustrialVideoOnlinePreview'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

const terminalLabels: Record<string, string> = { failed: '生成失败', cancelled: '已取消', blocked: '任务已阻塞' }
// const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)

export default function IndustrialVideoAgentProduction({
  sessionId,
  children,
  previewOpen,
  filePreviewActive = false,
  onPreviewOpenChange
}: {
  sessionId: string
  children: ReactNode
  previewOpen?: boolean
  filePreviewActive?: boolean
  onPreviewOpenChange?: (open: boolean) => void
}) {
  const { record, job, error, jobError, refresh } = useIndustrialVideoProduction(sessionId)
  const run = record?.run
  const state = record?.state ?? ''
  const jobId = record?.jobId
  const progress = (!job?.run || job.run === run ? job?.progress : undefined) as Record<string, unknown> | undefined
  const [storyboard, setStoryboard] = useState<{ run: string; count: number } | null>(null)
  // MEA: 顶栏开关驱动受控显隐；未受控时保留 standalone 自动打开行为。
  const isControlled = previewOpen !== undefined && onPreviewOpenChange !== undefined
  const [internalOpen, setInternalOpen] = useState(false)
  const open = isControlled ? previewOpen : internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) onPreviewOpenChange?.(next)
      else setInternalOpen(next)
    },
    [isControlled, onPreviewOpenChange]
  )
  const opened = useRef(new Set<string>())
  // const [video, setVideo] = useState<{ key: string; path: AbsoluteFilePath } | null>(null)
  // const [previewError, setPreviewError] = useState('')
  // const [retry, setRetry] = useState(0)
  const generationConfirmed = record?.rounds.some(
    (round) =>
      round.run === run &&
      round.jobId === jobId &&
      round.outcome === 'ok' &&
      ['video_start', 'assemble', 'scene_retry'].includes(round.operation)
  )
  const active = Boolean(run && jobId && generationConfirmed && ['generating', 'assembling', 'done'].includes(state))
  const visible = active || Boolean(run && jobId && generationConfirmed && terminalLabels[state])
  const identity = `${sessionId}:${run}:${jobId}`
  // const total = count(progress?.total_scenes) ?? count(progress?.total)
  // const done = count(progress?.scenes_done) ?? count(progress?.done)
  // const loadingProgress = readGenerationProgress(progress, state, storyboard?.run === run ? storyboard.count : null)
  const loadingProgress = readGenerationProgress(
    progress,
    state,
    storyboard && storyboard.run === run ? storyboard.count : null
  )
  const { total, done } = loadingProgress
  const finalPath = typeof progress?.final === 'string' ? progress.final : ''
  const stale = progress?.final_stale === true
  const artifactKey = `${identity}:${finalPath}`
  const terminal =
    terminalLabels[state] ||
    (job?.status === 'failed'
      ? '生成失败'
      : job?.status === 'cancelled'
        ? '已取消'
        : job?.status === 'blocked'
          ? '任务已阻塞'
          : '')
  const finished = active && state === 'done' && !stale && !terminal

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(() => void poll(), 3000)
    }
    timer = setTimeout(() => void poll(), 3000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refresh])

  useEffect(() => {
    // 受控模式由顶栏状态驱动，初始刷新（poll）不自动打开，也不覆盖用户收起的状态。
    if (isControlled) return
    if (!visible || opened.current.has(identity)) return
    opened.current.add(identity)
    setInternalOpen(true)
  }, [visible, identity, isControlled])

  useEffect(() => {
    if (!visible || !run) return
    let alive = true
    void ipcApi
      .request('industrial_video.storyboard_get', { sessionId, run, full: false })
      .then((response) => {
        const board = (response.storyboard ?? response) as Record<string, unknown>
        if (alive && Array.isArray(board.scenes)) setStoryboard({ run, count: board.scenes.length })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [visible, sessionId, run])

  /* 停用预览自动下载，在线预览与手动下载独立处理。
  useEffect(() => {
    setPreviewError('')
    if (!finished || !finalPath || !run) return
    let alive = true
    void ipcApi
      .request('industrial_video.download_artifact', { sessionId, run, path: finalPath })
      .then((result) => {
        const path = normalizeFilePreviewPath(result.filePath)
        if (!path) throw new Error('成片文件路径无效')
        if (alive) setVideo({ key: artifactKey, path })
      })
      .catch((cause) => {
        if (alive)
          setPreviewError(`生成已完成，但预览加载失败：${cause instanceof Error ? cause.message : String(cause)}`)
      })
    return () => {
      alive = false
    }
  }, [finished, finalPath, run, sessionId, artifactKey, retry])
  */

  // 生成期间的临时失效标记不能覆盖制作进度或停止动效。
  const showStale = stale && state === 'done'
  // const summary = terminal || (stale ? '当前成片已过期，请等待当前版本生成' : finished ? '视频生成完成' : loadingProgress.label)
  const summary =
    terminal || (showStale ? '当前成片已过期，请等待当前版本生成' : finished ? '视频生成完成' : loadingProgress.label)
  const steps = [
    { label: '准备画面', done: finished, detail: finished ? '已完成' : '详细进度待返回' },
    ...Array.from({ length: total ?? 0 }, (_, index) => ({
      label: `生成分镜 ${index + 1}`,
      done: finished,
      detail: finished ? '已完成' : '详细进度待返回'
    })),
    { label: '配音与字幕', done: finished, detail: finished ? '已完成' : '详细进度待返回' },
    {
      label: '拼接成片',
      done: finished,
      detail: finished ? '已完成' : state === 'assembling' ? '进行中' : '详细进度待返回'
    }
  ]
  const renderSteps = (toolName: string, output: unknown) => {
    if (!visible || normalizeMeacoworkToolRuntimeName(toolName) !== toMeacoworkToolRuntimeName('ivideo_start'))
      return null
    try {
      const content = (output as { content?: { type: string; text?: string }[] })?.content
      const value = JSON.parse(content?.find((part) => part.type === 'text')?.text ?? 'null')
      if (value?.ok !== true || value.jobId !== jobId) return null
    } catch {
      return null
    }
    return (
      <ToolDisclosure
        defaultActiveKey={['production']}
        items={[
          {
            key: 'production',
            label: summary,
            children: (
              <section aria-label="视频制作步骤" className="space-y-3 border-l border-border pl-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <strong>{summary}</strong>
                  <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                    查看成片
                  </Button>
                </div>
                <p role="status">
                  {done !== null && total !== null
                    ? `已完成 ${done}/${total} 镜`
                    : total !== null
                      ? `共 ${total} 镜，详细进度待返回`
                      : '详细进度待返回'}
                </p>
                <ol className="space-y-2">
                  {steps.map((step) => (
                    <li key={step.label} className="flex justify-between gap-3">
                      <span>{step.label}</span>
                      <span className="text-muted-foreground">
                        {step.done ? '✓ ' : ''}
                        {step.detail}
                      </span>
                    </li>
                  ))}
                </ol>
                {(error || jobError) && (
                  <p role="alert" className="text-error">
                    {error || jobError}
                  </p>
                )}
              </section>
            )
          }
        ]}
      />
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ToolResultAttachmentsContext value={renderSteps}>{children}</ToolResultAttachmentsContext>
      </div>
      {/* {visible && open && ( */}
      {visible && open && !(finished && filePreviewActive) && (
        <aside
          aria-label="成片预览"
          className="flex w-[380px] max-w-[45%] shrink-0 flex-col border-l border-border bg-card">
          <header className="flex items-center justify-between border-b border-border p-3">
            <strong>成片</strong>
            <Button size="sm" variant="ghost" aria-label="关闭成片预览" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {/* 原本地 FilePreview 改为服务端签名页面，不再为预览下载。 */}
            {finished && run && finalPath ? (
              <IndustrialVideoOnlinePreview
                key={artifactKey}
                sessionId={sessionId}
                run={run}
                finalPath={finalPath}
                previewUrl={progress?.preview_url}
              />
            ) : (
              /* 原转圈与重复进度文案保留，统一改用服务端进度组件。
              <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-sm">
                {!terminal && !stale && (
                  <LoaderCircle aria-hidden="true" className="animate-spin text-muted-foreground" />
                )}
                <p>{finished ? (finalPath ? '正在加载成片预览…' : '生成已完成，等待成片文件信息') : summary}</p>
                {!finished && !terminal && (
                  <p className="text-muted-foreground">
                    {total === null
                      ? '详细进度待返回'
                      : done === null
                        ? `共 ${total} 镜，详细进度待返回`
                        : `已完成 ${done}/${total} 镜`}
                  </p>
                )}
                {/* {previewError && (
                  <>
                    <p role="alert" className="text-error">
                      {previewError}
                    </p>
                    <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                      重试预览
                    </Button>
                  </>
                )}
              </div>
              */
              <IndustrialVideoGenerationLoading
                progress={loadingProgress}
                // stopped={terminal || (stale ? summary : finished ? '生成已完成，等待成片文件信息' : undefined)}
                stopped={terminal || (showStale ? summary : finished ? '生成已完成，等待成片文件信息' : undefined)}
                error={error || jobError}
              />
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
