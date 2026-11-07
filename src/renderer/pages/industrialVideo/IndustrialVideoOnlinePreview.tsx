import { useEffect, useRef, useState } from 'react'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

function safePreviewUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export default function IndustrialVideoOnlinePreview({
  sessionId,
  run,
  finalPath,
  previewUrl,
  // mediaUrl,
  onDownloaded
}: {
  sessionId: string
  run: string
  finalPath: string
  previewUrl?: unknown
  // mediaUrl?: unknown
  onDownloaded?: (path: string) => void
}) {
  // 轮询会刷新签名时效，同一成片不因此重载播放器。
  const firstSupplied = useRef('')
  if (!firstSupplied.current) firstSupplied.current = safePreviewUrl(previewUrl)
  const supplied = firstSupplied.current
  const [url, setUrl] = useState(supplied)
  const [previewError, setPreviewError] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const downloadLock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    setPreviewError('')
    if (supplied && revision === 0) {
      setRefreshing(false)
      setUrl(supplied)
      return
    }
    setRefreshing(true)
    void ipcApi
      .request('industrial_video.preview_create', { sessionId, run })
      .then((result) => {
        if (cancelled) return
        const next = safePreviewUrl(result.preview_url)
        if (!next) throw new Error('服务端未提供可用的在线预览链接，请检查 IVIDEO_PUBLIC_BASE_URL 配置。')
        setPreviewError('')
        setUrl(next)
      })
      .catch((cause) => {
        if (!cancelled) setPreviewError(`预览加载失败：${cause instanceof Error ? cause.message : String(cause)}`)
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, run, supplied, revision])

  const download = async () => {
    if (downloadLock.current) return
    downloadLock.current = true
    setDownloading(true)
    setDownloadError('')
    try {
      // const result = await ipcApi.request('industrial_video.download_artifact', { sessionId, run, path: finalPath })
      const result = await ipcApi.request('industrial_video.save_artifact', { sessionId, run, path: finalPath })
      if (!result || !alive.current) return
      setSavedPath(result.filePath)
      onDownloaded?.(result.filePath)
    } catch (cause) {
      if (alive.current) setDownloadError(`下载失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      downloadLock.current = false
      if (alive.current) setDownloading(false)
    }
  }

  return (
    <section aria-label="在线成片预览" className="flex h-full min-h-0 flex-col gap-3 bg-background p-3 text-foreground">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!finalPath || downloading || Boolean(savedPath)} onClick={() => void download()}>
          {downloading ? '正在下载…' : savedPath ? '已下载 MP4' : '下载 MP4'}
        </Button>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => setRevision((value) => value + 1)}>
          刷新预览链接
        </Button>
      </div>
      {savedPath && (
        <p role="status" className="break-all text-xs text-muted-foreground">
          已保存：{savedPath}
        </p>
      )}
      {downloadError && (
        <p role="alert" className="text-sm text-error">
          {downloadError}
        </p>
      )}
      {previewError ? (
        <p role="alert" className="text-sm text-error">
          {previewError}
        </p>
      ) : url ? (
        <iframe
          key={`${revision}:${url}`}
          title="成片在线播放"
          src={url}
          sandbox=""
          referrerPolicy="no-referrer"
          allow="fullscreen"
          allowFullScreen
          className="min-h-80 w-full flex-1 border-0 bg-background"
          onError={() => setPreviewError('在线预览加载失败，请刷新预览链接后重试。')}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          正在获取在线预览链接…
        </p>
      )}
    </section>
  )
}
