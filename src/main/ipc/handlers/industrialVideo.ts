import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'

import { dialog } from 'electron'

import { application } from '@application'
import { assertOutsideManagedStorageMutation } from '@main/services/file'
import { copyNew } from '@main/utils/file'
import type { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'
import type { IpcHandlersFor } from '@shared/ipc/types'
import { AbsoluteFilePathSchema } from '@shared/types/file'

/**
 * Thin adapters for the industrial-video request routes. Each route maps 1:1 to a
 * typed `IndustrialVideoService` method — there is no generic `call(operation)`
 * pass-through, so the renderer can only reach the operations declared in the
 * schema allowlist. Business logic, session validation, config resolution, and
 * persistence all live in the service; these handlers only translate the parsed
 * route input into a service call.
 */
export const industrialVideoHandlers: IpcHandlersFor<typeof industrialVideoRequestSchemas> = {
  'industrial_video.stop': async (input) => application.get('IndustrialVideoService').stop(input),
  'industrial_video.review_snapshot_get': async (input) =>
    application.get('IndustrialVideoService').reviewSnapshotGet(input),
  'industrial_video.review_confirm': async (input) => application.get('IndustrialVideoService').reviewConfirm(input),
  'industrial_video.config_status': async () => application.get('IndustrialVideoService').configStatus(),
  'industrial_video.run_create': async (input) => application.get('IndustrialVideoService').runCreate(input),
  'industrial_video.parse': async (input) =>
    application.get('IndustrialVideoService').parse({
      sessionId: input.sessionId,
      run: input.run,
      texts: input.texts,
      media: input.media,
      logo: input.logo,
      voice: input.voice,
      aspectRatio: input.aspectRatio,
      style: input.style,
      targetDurationS: input.targetDurationS,
      resolution: input.resolution,
      ttsEnabled: input.ttsEnabled,
      subtitleEnabled: input.subtitleEnabled,
      backgroundMusicEnabled: input.backgroundMusicEnabled,
      withAudio: input.withAudio,
      expectedSettingsVersion: input.expectedSettingsVersion
    }),
  'industrial_video.planning_context_get': async (input) =>
    application.get('IndustrialVideoService').planningContextGet(input),
  'industrial_video.storyboard_get': async (input) => application.get('IndustrialVideoService').storyboardGet(input),
  'industrial_video.storyboard_submit': async (input) =>
    application.get('IndustrialVideoService').storyboardSubmit(input),
  'industrial_video.video_start': async (input) =>
    application.get('IndustrialVideoService').videoStart({
      sessionId: input.sessionId,
      run: input.run,
      voice: input.voice,
      aspectRatio: input.aspectRatio,
      style: input.style,
      targetDurationS: input.targetDurationS,
      resolution: input.resolution,
      ttsEnabled: input.ttsEnabled,
      subtitleEnabled: input.subtitleEnabled,
      backgroundMusicEnabled: input.backgroundMusicEnabled,
      withAudio: input.withAudio,
      expectedSettingsVersion: input.expectedSettingsVersion
    }),
  'industrial_video.estimate': async (input) =>
    application.get('IndustrialVideoService').estimate({
      sessionId: input.sessionId,
      run: input.run,
      voice: input.voice,
      aspectRatio: input.aspectRatio,
      style: input.style,
      targetDurationS: input.targetDurationS,
      resolution: input.resolution,
      ttsEnabled: input.ttsEnabled,
      subtitleEnabled: input.subtitleEnabled,
      backgroundMusicEnabled: input.backgroundMusicEnabled,
      withAudio: input.withAudio,
      expectedSettingsVersion: input.expectedSettingsVersion
    }),
  'industrial_video.assemble': async (input) => application.get('IndustrialVideoService').assemble(input),
  'industrial_video.job_get': async (input) => application.get('IndustrialVideoService').jobGet(input),
  'industrial_video.job_list': async (input) => application.get('IndustrialVideoService').jobList(input),
  'industrial_video.job_cancel': async (input) => application.get('IndustrialVideoService').jobCancel(input),
  'industrial_video.scene_retry': async (input) => application.get('IndustrialVideoService').sceneRetry(input),
  'industrial_video.qa_get': async (input) => application.get('IndustrialVideoService').qaGet(input),
  'industrial_video.preview_create': async (input) => application.get('IndustrialVideoService').previewCreate(input),
  'industrial_video.artifact_read': async (input) => application.get('IndustrialVideoService').artifactRead(input),
  'industrial_video.save_artifact': async (input, { senderId }) => {
    if (!senderId) throw new Error('另存为需要有效窗口。')
    const window = application.get('WindowManager').getWindow(senderId)
    if (!window) throw new Error('保存窗口已关闭。')
    const selected = await dialog.showSaveDialog(window, {
      title: '保存 MP4 视频',
      defaultPath: basename(input.path.replaceAll('\\\\', '/')),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (selected.canceled || !selected.filePath) return null
    const destination = AbsoluteFilePathSchema.parse(selected.filePath)
    await assertOutsideManagedStorageMutation(destination)
    // 不覆盖已有个人文件；下载失败也不触碰目标路径。
    try {
      await lstat(destination)
      throw new Error('目标文件已存在，请选择其他文件名。')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    const result = await application.get('IndustrialVideoService').downloadArtifact(input)
    await copyNew(AbsoluteFilePathSchema.parse(result.filePath), destination)
    return { filePath: destination, size: result.size }
  },
  'industrial_video.download_artifact': async (input) =>
    application.get('IndustrialVideoService').downloadArtifact(input),
  'industrial_video.media_upload': async (input) => application.get('IndustrialVideoService').mediaUpload(input),
  'industrial_video.logo_upload': async (input) => application.get('IndustrialVideoService').logoUpload(input),
  'industrial_video.upload': async (input) => application.get('IndustrialVideoService').upload(input),
  'industrial_video.snapshot_save': async (input) => application.get('IndustrialVideoService').snapshotSave(input),
  'industrial_video.get_records': async (input) => application.get('IndustrialVideoService').getRecords(input)
}
