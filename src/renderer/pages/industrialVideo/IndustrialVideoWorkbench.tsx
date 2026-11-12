import { useEffect, useRef, useState } from 'react'

import { Button } from '@cherrystudio/ui'
import { WebviewHost } from '@renderer/components/WebviewHost'
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoOnlinePreview from './IndustrialVideoOnlinePreview'
import type { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

type Production = ReturnType<typeof useIndustrialVideoProduction>

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
  production
}: {
  sessionId: string
  production: Production
}) {
  const run = production.record?.run ?? undefined
  const taskKey = `${sessionId}:${run ?? ''}`
  const currentTask = useRef(taskKey)
  currentTask.current = taskKey
  const [opened, setOpened] = useState<{ taskKey: string; url: string } | null>(null)
  const openedUrl = opened?.taskKey === taskKey ? opened.url : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

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
      setOpened({ taskKey, url: url.href })
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
  const onlineReady =
    done && Boolean(finalPath && run) && progress?.final_stale !== true && runMatches

  return (
    <aside
      aria-label="工业视频工作台"
      className="flex h-full min-h-0 flex-col bg-background text-foreground">
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
              脚本与分镜审核已迁移至服务端工作台。点击下方链接在工作台内完成审核与重规划；网页内部功能由服务端负责，额外授权也由网页自身处理。
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
