import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AbsoluteFilePath } from '@shared/types/file'

import VideoFilePreview from './VideoFilePreview'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPreview() {
  const { container } = render(
    <VideoFilePreview
      filePath={'/tmp/finished.mp4' as AbsoluteFilePath}
      fileName="finished.mp4"
      metadata={{ size: 128, modifiedAt: 1 }}
      refreshKey={0}
    />
  )
  return container.querySelector('video')!
}

describe('video preview readiness', () => {
  // Metadata-only preloading must not leave the player hidden waiting for a decoded frame.
  it('shows the player once metadata loads without requiring loadeddata', () => {
    const video = renderPreview()
    expect(screen.getByRole('status')).toHaveTextContent('file_preview.loading')

    fireEvent.loadedMetadata(video)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(video).not.toHaveClass('opacity-0')
    expect(video).toHaveAttribute('controls')
  })

  it('shows an already loaded video even if metadata arrived before handlers attached', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
    const video = renderPreview()

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(video).not.toHaveClass('opacity-0')
  })

  it('shows a contained error when media loading fails', () => {
    const video = renderPreview()
    fireEvent.error(video)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('file_preview.load_error.title')
  })
})
