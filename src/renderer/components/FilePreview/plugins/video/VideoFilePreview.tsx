import VideoOff from 'lucide-react/dist/esm/icons/video-off'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@cherrystudio/ui'
import { toFileUrl } from '@shared/utils/file'

import { FilePreviewLayout } from '../../FilePreviewLayout'
import type { FilePreviewPluginProps } from '../../types'

/**
 * Renders a local video file with native controls. The `src` is a `file://` URL
 * derived from the absolute path (mirrors the image plugin); it is never a
 * remote preview page.
 */
export default function VideoFilePreview({ filePath, fileName, refreshKey }: FilePreviewPluginProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading')
  const src = `${toFileUrl(filePath)}#t=0.001${refreshKey ? `&rk=${refreshKey}` : ''}`

  if (status === 'error') {
    return (
      <FilePreviewLayout.Frame>
        <FilePreviewLayout.Content>
          <div role="alert" className="h-full">
            <EmptyState
              icon={VideoOff}
              title={t('file_preview.load_error.title')}
              description={t('file_preview.load_error.description')}
              className="h-full"
            />
          </div>
        </FilePreviewLayout.Content>
      </FilePreviewLayout.Frame>
    )
  }

  return (
    <FilePreviewLayout.Frame>
      <FilePreviewLayout.Content>
        <div className="flex h-full min-h-full w-full items-center justify-center p-4">
          {status === 'loading' && (
            <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {t('file_preview.loading')}
            </div>
          )}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            key={src}
            className={`max-h-full max-w-full ${status === 'loading' ? 'opacity-0' : 'opacity-100'}`}
            controls
            preload="metadata"
            src={src}
            onLoadedData={() => setStatus('ready')}
            onError={() => setStatus('error')}>
            {fileName}
          </video>
        </div>
      </FilePreviewLayout.Content>
    </FilePreviewLayout.Frame>
  )
}
