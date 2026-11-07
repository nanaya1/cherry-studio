import type { FilePreviewPlugin } from '../../types'

/**
 * Plays local video files (downloaded industrial-video artifacts, recordings…)
 * directly from disk. `preview_create` returns a web review page and must NOT be
 * used as a `<video src>`; the real local file path from `download_artifact` is
 * what this plugin renders.
 */
export const videoFilePreviewPlugin = {
  id: 'video',
  extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'],
  load: () => import('./VideoFilePreview')
} satisfies FilePreviewPlugin
