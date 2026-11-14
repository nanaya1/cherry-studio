import { useEffect, useRef, useState } from 'react'

import { Button } from '@cherrystudio/ui'
import { WebviewHost } from '@renderer/components/WebviewHost'
import { ipcApi } from '@renderer/ipc'

import { START_VIDEO_MESSAGE } from './IndustrialVideoGenerateButton'
import IndustrialVideoOnlinePreview from './IndustrialVideoOnlinePreview'
import { openIndustrialVideoWorkbench } from './industrialVideoProgressStore'
// 稿件展示统一放在工作台，保留原组件以便恢复。
// import IndustrialVideoReviewFiles from './IndustrialVideoReviewFiles'
import type { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

type Production = ReturnType<typeof useIndustrialVideoProduction>

interface WorkbenchProps {
  sessionId: string
  production: Production
  resumeStages?: (run: string) => Promise<unknown>
  executing?: boolean
  reviewOutput?: Record<string, unknown>
  /** 审核确认后发送生成消息；旧调用方保留直接提交兼容。 */
  sendMessage?: (message: { text: string }) => Promise<boolean>
}

/**
 * 工业专用工作台：替换原 DedicatedIndustrialVideoReview 的本地脚本/分镜确认面板。
 * 只展示一个可点击的工作台链接；点击后在已有右侧区域用独立 WebviewHost 打开服务端网页
 * （frame-ancestors=self 的页面无法用 iframe 嵌入，故用 Electron webview）。
 * 成片在线预览仍由 IndustrialVideoOnlinePreview 负责，播放器不改动。
 *
 * 安全边界：
 *  - 主进程只返回可信 workbench_url，渲染层绝不在本地注入任何服务令牌；
 *  - 不向网页提供任何桥接（window.cherry 等），网页内部功能完全由服务端负责；
 *  - 工作台使用独立、非持久化的 partition，避免与其它 guest 共享 cookie/storage。
 */
export default function IndustrialVideoWorkbench({
  sessionId,
  production,
  resumeStages,
  executing,
  reviewOutput,
  sendMessage: sendGeneration
}: WorkbenchProps) {
  const run = production.record?.run ?? undefined
  const taskKey = `${sessionId}:${run ?? ''}`
  const currentTask = useRef(taskKey)
  currentTask.current = taskKey
  const [opened, setOpened] = useState<{ taskKey: string; url: string } | null>(null)
  const openedUrl = opened?.taskKey === taskKey ? opened.url : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<{ taskKey: string; snapshot: Record<string, unknown> } | null>(null)
  const [handled, setHandled] = useState(false)
  // 原消息快照优先逻辑保留：const snapshot = reviewOutput ?? review?.snapshot
  const snapshot = (review?.taskKey === taskKey ? review.snapshot : null) ?? reviewOutput
  const [syncState, setSyncState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [updated, setUpdated] = useState(false)
  const syncing = useRef(false)
  const unavailable =
    handled || (Boolean(reviewOutput) && syncState !== 'ready') || Boolean(production.record?.unknownSubmissions.length)
  const actionLock = useRef(false)
  const lastRound = production.record?.rounds?.at(-1)
  const recoveryVersion =
    lastRound?.operation === 'storyboard_stage_task_get' &&
    lastRound.run === run &&
    lastRound.detail?.lifecycle === 'executing' &&
    typeof lastRound.detail.expected_task_version === 'string'
      ? lastRound.detail.expected_task_version
      : undefined
  const retryStage = async () => {
    if (
      actionLock.current ||
      executing ||
      !run ||
      !recoveryVersion ||
      !resumeStages ||
      production.record?.unknownSubmissions.length
    )
      return
    actionLock.current = true
    setBusy(true)
    setError('')
    try {
      const receipt = await ipcApi.request('industrial_video.stage_retry', {
        sessionId,
        run,
        expectedTaskVersion: recoveryVersion
      })
      if (!alive.current || currentTask.current !== taskKey) return
      if (!receipt.retried) throw new Error('阶段任务未恢复，未启动模型。')
      await resumeStages(run)
    } catch (cause) {
      if (alive.current && currentTask.current === taskKey)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionLock.current = false
      if (alive.current) setBusy(false)
      await production.refresh()
    }
  }
  const reviewAction = async (action?: 'regenerate_storyboard' | 'generate_video') => {
    if (actionLock.current || !run || executing || (action && unavailable)) return
    actionLock.current = true
    setBusy(true)
    setError('')
    try {
      if (!action) {
        const result = await ipcApi.request('industrial_video.cowork_review_get', { sessionId, run })
        if (alive.current && currentTask.current === taskKey) setReview({ taskKey, snapshot: result })
        return
      }
      if (!snapshot || typeof snapshot.review_version !== 'string') throw new Error('审核内容尚未同步。')
      const latest = await ipcApi.request('industrial_video.cowork_review_get', { sessionId, run })
      if (!alive.current || currentTask.current !== taskKey) return
      setReview({ taskKey, snapshot: latest })
      if (latest.review_version !== snapshot.review_version) {
        setUpdated(true)
        return
      }
      if (!Array.isArray(latest.allowed_actions) || !latest.allowed_actions.includes(action)) {
        throw new Error('当前状态不允许此操作，请查看最新内容。')
      }
      const receipt = await ipcApi.request('industrial_video.cowork_review_confirm', {
        sessionId,
        run,
        expectedReviewVersion: snapshot.review_version,
        action
      })
      if (!alive.current || currentTask.current !== taskKey) return
      setReview(null)
      setHandled(true)
      if (action === 'regenerate_storyboard') {
        if (receipt.task_operation !== 'storyboard_stage_task_get' || !resumeStages)
          throw new Error('服务端未返回可执行阶段任务。')
        await resumeStages(run)
      } else if (sendGeneration) {
        // 确认成功即结束本面板动作；真实生成由「开始生成视频」消息进入既有会话链路，
        // 单一提交入口，避免按钮直提与消息链路双提交。
        if (
          receipt.generation_allowed !== true ||
          !Array.isArray(receipt.remaining_blockers) ||
          receipt.remaining_blockers.length ||
          !['video', 'assemble'].includes(String(receipt.next_stage))
        ) {
          throw new Error(`生成尚未就绪：${JSON.stringify(receipt.remaining_blockers ?? receipt)}`)
        }
        const succeeded = await sendGeneration({ text: START_VIDEO_MESSAGE })
        if (!succeeded) throw new Error('已确认当前版本，但生成消息发送失败，请在对话框手动发送「开始生成视频」。')
      } else {
        // 原按钮直接提交路径保留（未接入 sendMessage 的调用方回滚用）。
        if (
          receipt.generation_allowed !== true ||
          !Array.isArray(receipt.remaining_blockers) ||
          receipt.remaining_blockers.length ||
          !['video', 'assemble'].includes(String(receipt.next_stage))
        ) {
          throw new Error(`生成尚未就绪：${JSON.stringify(receipt.remaining_blockers ?? receipt)}`)
        }
        const estimate = await ipcApi.request('industrial_video.estimate', { sessionId, run })
        if (
          estimate.requiresReplan ||
          estimate.approvalInvalidated ||
          !alive.current ||
          currentTask.current !== taskKey
        ) {
          throw new Error('预检要求重新审核，未提交生成。')
        }
        if (receipt.next_stage === 'assemble') await ipcApi.request('industrial_video.assemble', { sessionId, run })
        else await ipcApi.request('industrial_video.video_start', { sessionId, run })
      }
    } catch (cause) {
      if (alive.current && currentTask.current === taskKey)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionLock.current = false
      if (alive.current) setBusy(false)
      await production.refresh()
    }
  }
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const syncReview = async () => {
    if (!run || executing || handled || syncing.current || actionLock.current) return
    syncing.current = true
    setSyncState('loading')
    try {
      const result = await ipcApi.request('industrial_video.cowork_review_get', { sessionId, run })
      if (!alive.current || currentTask.current !== taskKey) return
      if (snapshot && result.review_version !== snapshot.review_version) setUpdated(true)
      setReview({ taskKey, snapshot: result })
      setSyncState('ready')
    } catch {
      if (alive.current && currentTask.current === taskKey) setSyncState('failed')
    } finally {
      syncing.current = false
    }
  }
  const syncLatest = useRef(syncReview)
  syncLatest.current = syncReview
  useEffect(() => {
    if (!run || executing !== false || production.record?.state !== 'storyboard_submitted') return
    const sync = () => {
      if (document.visibilityState !== 'hidden') void syncLatest.current()
    }
    sync()
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    const timer = window.setInterval(sync, 10000)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [sessionId, run, taskKey, executing, production.record?.state])

  const openWorkbench = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await ipcApi.request('industrial_video.workbench_open', {
        sessionId,
        run
      })
      if (!alive.current || currentTask.current !== taskKey) return
      const url = new URL(result.workbench_url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || result.run !== run)
        throw new Error('工作台链接无效。')
      if (reviewOutput && run) openIndustrialVideoWorkbench(sessionId, run, url.href)
      else setOpened({ taskKey, url: url.href })
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  // 成片在线预览状态（保留原 OnlinePreview，不改动播放器）。
  const progress = production.job?.progress as Record<string, unknown> | undefined
  const finalPath = typeof progress?.final === 'string' ? progress.final : ''
  const done = production.job?.status === 'done'
  const runMatches = !production.job?.run || production.job.run === run
  const onlineReady = done && Boolean(finalPath && run) && progress?.final_stale !== true && runMatches

  if (reviewOutput) {
    const settings = snapshot?.effective_settings as Record<string, unknown> | undefined
    const board = snapshot?.storyboard as { scenes?: unknown[] } | undefined
    return (
      <section aria-label="客户端审核" className="my-3 space-y-3 text-sm">
        <p className="font-medium">分镜预览已完成，请核对内容。</p>
        <p className="text-xs text-muted-foreground">
          {String(settings?.target_duration_s ?? '—')} 秒 · {String(settings?.aspect_ratio ?? '—')} ·{' '}
          {String(settings?.resolution ?? '—')} · {board?.scenes?.length ?? 0} 个镜头
        </p>
        {/* <IndustrialVideoReviewFiles output={reviewOutput} /> */}
        {/* <IndustrialVideoReviewFiles output={snapshot ?? reviewOutput} sessionId={sessionId} run={run} /> */}
        {/* 成功状态不常驻提示；原成功文案：已同步最新内容。 */}
        {(syncState !== 'ready' || updated) && (
          <p role="status" className="text-xs text-muted-foreground">
            {syncState === 'loading'
              ? '正在同步内容…'
              : syncState === 'failed'
                ? '暂时无法同步最新内容。'
                : '内容已更新，请到工作台核对后再生成。'}
          </p>
        )}
        {/* 原手动刷新入口由自动同步及失败重试替代。
          <Button onClick={() => void reviewAction()}>刷新内容</Button>
        */}
        {syncState === 'failed' && (
          <Button variant="ghost" disabled={busy || executing} onClick={() => void syncReview()}>
            重试同步
          </Button>
        )}
        {handled && <p role="status">此版本已处理，请查看后续消息。</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            // variant="ghost"
            variant="outline"
            disabled={busy}
            onClick={() => void openWorkbench()}>
            {/* 原入口文案：编辑内容 */}
            打开工作台
          </Button>
          {/* 重生成入口统一放在工作台，保留原入口以便恢复。 */}
          {/* <Button
            variant="ghost"
            disabled={
              busy ||
              executing ||
              unavailable ||
              !Array.isArray(snapshot?.allowed_actions) ||
              !snapshot.allowed_actions.includes('regenerate_storyboard')
            }
            onClick={() => void reviewAction('regenerate_storyboard')}>
            重新生成分镜
          </Button> */}
          <Button
            disabled={
              busy ||
              executing ||
              unavailable ||
              !Array.isArray(snapshot?.allowed_actions) ||
              !snapshot.allowed_actions.includes('generate_video')
            }
            onClick={() => void reviewAction('generate_video')}>
            确认并生成视频
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">生成视频即确认当前全文、分镜并授权生成。</p>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </section>
    )
  }

  return (
    <aside aria-label="工业视频工作台" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <section className="space-y-2 border-b border-border p-3" aria-label="客户端审核">
        {recoveryVersion && (
          <Button
            variant="outline"
            disabled={busy || executing || !resumeStages || Boolean(production.record?.unknownSubmissions.length)}
            onClick={() => void retryStage()}>
            明确重试当前阶段任务
          </Button>
        )}
        <Button variant="outline" disabled={busy || executing || !run} onClick={() => void reviewAction()}>
          刷新审核内容
        </Button>
        {snapshot && (
          <>
            <p className="text-xs text-muted-foreground">审核版本：{String(snapshot.review_version)}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{String(snapshot.script)}</pre>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(snapshot.storyboard, null, 2)}
            </pre>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(snapshot.effective_settings, null, 2)}
            </pre>
            <Button
              variant="outline"
              disabled={
                busy ||
                executing ||
                !Array.isArray(snapshot.allowed_actions) ||
                !snapshot.allowed_actions.includes('regenerate_storyboard')
              }
              onClick={() => void reviewAction('regenerate_storyboard')}>
              确认全文素材，修改动作分镜
            </Button>
            <p className="text-xs text-muted-foreground">点击即确认当前全文与动作分镜并授权生成视频。</p>
            <Button
              disabled={
                busy ||
                executing ||
                !Array.isArray(snapshot.allowed_actions) ||
                !snapshot.allowed_actions.includes('generate_video')
              }
              onClick={() => void reviewAction('generate_video')}>
              生成视频
            </Button>
          </>
        )}
        {error && openedUrl && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </section>
      <div className="flex min-h-0 flex-1 flex-col">
        {openedUrl ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border p-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpened(null)}>
                收起工作台
              </Button>
              <span className="text-xs text-muted-foreground">服务端工作台（内置网页）</span>
            </div>
            <div className="min-h-0 flex-1">
              <WebviewHost
                id={`industrial-video-workbench:${sessionId}`}
                src={openedUrl}
                partition={`industrial-video-workbench:${taskKey}`}
                ariaLabel="服务端工作台网页"
                testId="industrial-video-workbench-guest"
                className="h-full w-full"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              工作台仅编辑并保存全文与分镜；保存后返回客户端，点击“刷新审核内容”查看同版内容并确认。
            </p>
            <div>
              <Button variant="outline" disabled={busy} onClick={() => void openWorkbench()}>
                打开服务端工作台
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            {production.error && (
              <p role="alert" className="text-sm text-error">
                {production.error}
              </p>
            )}
          </div>
        )}
      </div>
      {onlineReady && !openedUrl && (
        <div className="border-t border-border">
          <IndustrialVideoOnlinePreview
            key={`${sessionId}:${run}:${production.record?.jobId}:${finalPath}`}
            sessionId={sessionId}
            run={run!}
            finalPath={finalPath}
            previewUrl={progress?.preview_url}
          />
        </div>
      )}
    </aside>
  )
}
