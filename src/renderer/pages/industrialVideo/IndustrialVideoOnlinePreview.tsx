import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
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
        if (!next) throw new Error(t('industrial_video.preview.missing_url'))
        setPreviewError('')
        setUrl(next)
      })
      .catch((cause) => {
        if (!cancelled)
          setPreviewError(
            t('industrial_video.preview.load_failed', { error: cause instanceof Error ? cause.message : String(cause) })
          )
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, run, supplied, revision, t])

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
      if (alive.current)
        setDownloadError(
          t('industrial_video.preview.download_failed', {
            error: cause instanceof Error ? cause.message : String(cause)
          })
        )
    } finally {
      downloadLock.current = false
      if (alive.current) setDownloading(false)
    }
  }

  return (
    <section
      aria-label={t('industrial_video.preview.online_label')}
      className="flex h-full min-h-0 flex-col gap-3 bg-background p-3 text-foreground">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!finalPath || downloading || Boolean(savedPath)} onClick={() => void download()}>
          {downloading
            ? t('industrial_video.preview.downloading')
            : savedPath
              ? t('industrial_video.preview.downloaded')
              : t('industrial_video.preview.download')}
        </Button>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => setRevision((value) => value + 1)}>
          {t('industrial_video.preview.refresh_link')}
        </Button>
      </div>
      {savedPath && (
        <p role="status" className="break-all text-xs text-muted-foreground">
          {t('industrial_video.preview.saved', { path: savedPath })}
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
          title={t('industrial_video.preview.player_title')}
          src={url}
          sandbox=""
          referrerPolicy="no-referrer"
          allow="fullscreen"
          allowFullScreen
          className="min-h-80 w-full flex-1 border-0 bg-background"
          onError={() => setPreviewError(t('industrial_video.preview.player_failed'))}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('industrial_video.preview.loading_link')}
        </p>
      )}
    </section>
  )
}
