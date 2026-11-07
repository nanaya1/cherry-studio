import * as z from 'zod'

import { ipcApi } from '@renderer/ipc'

export const industrialStoryboardSchema = z
  .object({
    video_title: z.string().trim().min(1),
    scenes: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            title: z.string().trim().min(1),
            duration: z.number().positive().optional()
          })
          .passthrough()
      )
      .min(1)
  })
  .passthrough()
  .refine((board) => new Set(board.scenes.map((scene) => scene.id)).size === board.scenes.length, 'Duplicate scene ids')

export type IndustrialStoryboard = z.infer<typeof industrialStoryboardSchema>

export function parseIndustrialStoryboard(text: string): IndustrialStoryboard {
  return industrialStoryboardSchema.parse(
    JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    )
  )
}

export async function prepareIndustrialStoryboard(
  sessionId: string,
  run: string,
  jobId: string,
  generate: (context: Record<string, unknown>) => Promise<string>
): Promise<IndustrialStoryboard> {
  const job = await ipcApi.request('industrial_video.job_get', { sessionId, jobId })
  if (job.status !== 'done' || job.run !== run) throw new Error('解析尚未完成或任务不属于当前版本，请刷新后继续。')
  const context = await ipcApi.request('industrial_video.planning_context_get', { sessionId, run })
  // 素材未就绪时不能提交分镜，否则服务端会因来源缺失而拒绝或错配。
  if (context.sources_ready === false) throw new Error('素材尚未就绪，已阻止提交分镜，请确认素材上传完成后再提交。')
  if (
    typeof context.input_fingerprint !== 'string' ||
    !context.input_fingerprint ||
    typeof context.expected_storyboard_sha256 !== 'string'
  ) {
    throw new Error('规划上下文缺少服务端指纹，已停止提交，请核对服务端 HTTP 响应。')
  }
  const storyboard = parseIndustrialStoryboard(await generate(context))
  const result = await ipcApi.request('industrial_video.storyboard_submit', {
    sessionId,
    run,
    storyboard,
    expectedInputFingerprint: context.input_fingerprint,
    expectedStoryboardSha256: context.expected_storyboard_sha256
  })
  if (!result.submitted) throw new Error('服务端未接受分镜，请刷新规划上下文后检查。')
  return storyboard
}

/** 统一上传入口：POST 原始字节到服务根 `/upload`，返回 `{ name }` 句柄；不进渲染进程的 Token。 */
export async function uploadIndustrialContent(sessionId: string, name: string, content: Uint8Array) {
  if (content.byteLength > 500 * 1024 * 1024) throw new Error('素材或 Logo 超过首版 500MiB 上传限制。')
  return ipcApi.request('industrial_video.upload', { sessionId, name, content })
}

export async function uploadIndustrialMedia(sessionId: string, path: string, name: string) {
  const { AbsoluteFilePathSchema } = await import('@shared/types/file')
  const { createFilePathHandle } = await import('@shared/utils/file')
  const handle = createFilePathHandle(AbsoluteFilePathSchema.parse(path))
  const metadata = await ipcApi.request('file.get_metadata', handle)
  if (!metadata || metadata.kind !== 'file') throw new Error('素材不存在，无法上传。')
  if (metadata.size > 500 * 1024 * 1024) throw new Error('素材超过 500MiB 上传限制。')
  const file = await ipcApi.request('file.read', { handle, options: { mode: 'full', encoding: 'binary' } })
  const content = new Uint8Array(file.content)
  // 材料描述（caption）仍在 parse 步骤携带，这里只负责上传字节并返回 name 句柄。
  return uploadIndustrialContent(sessionId, name, content)
}

/** Logo 与素材走同一上传入口，避免暴露任意 URL 或 base64 旁路。 */
export async function uploadIndustrialLogo(sessionId: string, name: string, dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',')
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
  const binary = atob(base64)
  const content = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) content[i] = binary.charCodeAt(i)
  // MEA:industrial-video 原始文件名只供展示，上传句柄必须满足服务端字符与长度限制。
  // return uploadIndustrialContent(sessionId, name, content)
  const extension = name.match(/\.(png|jpe?g|webp)$/i)?.[1].toLowerCase()
  const uploadName = `logo-${crypto.randomUUID()}${extension ? `.${extension}` : ''}`
  return uploadIndustrialContent(sessionId, uploadName, content)
}
