import * as z from 'zod'

import { encodeOrgId, type OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'

import { OrgApiHttpError } from './OrgApiClient'

export const firstShareStateSchema = z.object({
  name: z.string(),
  creation: z.enum(['intent', 'unknown', 'created']),
  shareId: z.string().nullable(),
  files: z.array(
    z.object({
      itemId: z.string(),
      fileName: z.string(),
      size: z.number(),
      hash: z.string(),
      fingerprint: z.string(),
      phase: z.enum(['pending', 'intent', 'unknown', 'failure', 'success']),
      fileId: z.string().nullable(),
      error: z.string().nullable()
    })
  )
})
export type FirstShareState = z.infer<typeof firstShareStateSchema>
export type FirstShareEntry = {
  itemId: string
  fileName: string
  path: string
  size: number
  hash: string
  fingerprint: string
  chunks: unknown[]
}
export type FirstShareProgress = {
  phase: 'counting' | 'uploading' | 'confirming' | 'paused' | 'completed'
  totalBytes: number
  uploadedBytes: number
  completedFiles: number
  totalFiles: number
  currentFile: string | null
  error: string | null
}
type Store = { get(key: string): FirstShareState | undefined; set(key: string, state: FirstShareState): void }
type Client = {
  createShareSpace(name: string): Promise<{ share_id: string }>
  uploadShareStream(
    shareId: string,
    entry: FirstShareEntry,
    progress: (bytes: number) => void
  ): Promise<{ share_id: string; file_id: string; chunk_count: number }>
  verify(shareId: string, fileId: string, entry: FirstShareEntry): Promise<void>
}

// MEA:enterprise-knowledge-page 写前日志跨进程重启保留；未知请求永不自动重放。
export class FirstShareUpload {
  constructor(
    private readonly store: Store,
    private readonly client: Client
  ) {}

  async run(
    key: string,
    name: string,
    plan: () => Promise<FirstShareEntry[]>,
    report: (state: FirstShareProgress) => void,
    active: () => void,
    verifyOnly = false
  ): Promise<OrgKnowledgeShareResult> {
    active()
    report({
      phase: 'counting',
      totalBytes: 0,
      uploadedBytes: 0,
      completedFiles: 0,
      totalFiles: 0,
      currentFile: null,
      error: null
    })
    const entries = (await plan()).sort((a, b) => a.itemId.localeCompare(b.itemId))
    active()
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    // MEA:enterprise-knowledge-page 暂不设置客户端总容量上限，旧检查保留供回溯。
    // if (totalBytes >= 2 ** 31) throw new Error('知识库原文件总大小必须严格小于 2 GiB')
    // if (totalBytes >= 20 * 1024 * 1024) throw new Error('知识库原文件总大小必须严格小于 20 MiB')
    if (!entries.length) throw new Error('该知识库没有可分享文件')
    let state = this.store.get(key)
    const persist = () => this.store.set(key, state!)
    if (!state && verifyOnly) throw new Error('没有可核对的上传任务')
    if (!state) {
      state = {
        name,
        creation: 'intent',
        shareId: null,
        files: entries.map((entry) => ({
          itemId: entry.itemId,
          fileName: entry.fileName,
          size: entry.size,
          hash: entry.hash,
          fingerprint: entry.fingerprint,
          phase: 'pending',
          fileId: null,
          error: null
        }))
      }
      persist()
      try {
        active()
        const created = await this.client.createShareSpace(name)
        state.shareId = created.share_id
        state.creation = 'created'
        persist()
        active()
      } catch (error) {
        if (!state.shareId) state.creation = 'unknown'
        persist()
        report({
          phase: 'paused',
          totalBytes,
          uploadedBytes: 0,
          completedFiles: 0,
          totalFiles: entries.length,
          currentFile: null,
          error: error instanceof Error ? error.message : String(error)
        })
        return this.result(state)
      }
    }
    const progress: FirstShareProgress = {
      phase: 'confirming',
      totalBytes,
      uploadedBytes: 0,
      completedFiles: 0,
      totalFiles: entries.length,
      currentFile: null,
      error: null
    }
    const pause = (message: string) => {
      progress.phase = 'paused'
      progress.error = message
      report({ ...progress })
    }
    if (state.creation !== 'created' || !state.shareId) {
      pause('创建云端库结果未知，请稍后核对或联系管理员核查；不能重新创建。')
      return this.result(state)
    }
    if (
      state.files.length !== entries.length ||
      state.files.some(
        (file, index) =>
          file.itemId !== entries[index]?.itemId ||
          file.fingerprint !== entries[index]?.fingerprint ||
          file.fileName !== entries[index]?.fileName
      )
    ) {
      pause('本地文件已变化，请恢复原文件后核对，或联系管理员核查。')
      return this.result(state, false)
    }
    for (const [index, file] of state.files.entries()) {
      active()
      const entry = entries[index]
      progress.currentFile = file.fileName
      try {
        if (file.fileId) {
          progress.phase = 'confirming'
          report({ ...progress })
          await this.client.verify(state.shareId, file.fileId, entry)
          active()
          file.phase = 'success'
          file.error = null
          persist()
        } else if (file.phase === 'intent' || file.phase === 'unknown') {
          file.phase = 'unknown'
          file.error = file.error ?? '请求结果未知且没有可信文件ID，请稍后核对或联系管理员核查；禁止自动重传。'
          persist()
          pause(file.error)
          break
        } else if (!verifyOnly) {
          file.phase = 'intent'
          file.error = null
          persist()
          active()
          progress.phase = 'uploading'
          report({ ...progress })
          const before = progress.uploadedBytes
          const uploaded = await this.client.uploadShareStream(state.shareId, entry, (bytes) => {
            active()
            progress.uploadedBytes = before + Math.min(bytes, entry.size)
            report({ ...progress })
          })
          // MEA:enterprise-knowledge-page 响应归属和分块数通过后，ID才可用于恢复核对。
          if (uploaded.share_id !== state.shareId || uploaded.chunk_count !== entry.chunks.length)
            throw new Error('上传响应未确认')
          // 先保存可信ID，再做会话/目录核对，关闭切号窗口内的响应丢失风险。
          file.fileId = uploaded.file_id
          persist()
          active()
          // if (uploaded.share_id !== state.shareId || uploaded.chunk_count !== entry.chunks.length)
          //   throw new Error('上传响应未确认')
          progress.phase = 'confirming'
          report({ ...progress })
          await this.client.verify(state.shareId, file.fileId, entry)
          active()
          file.phase = 'success'
          persist()
        }
      } catch (error) {
        file.phase =
          !file.fileId && error instanceof OrgApiHttpError && [401, 403, 413, 422].includes(error.status)
            ? 'failure'
            : 'unknown'
        file.error = error instanceof Error ? error.message : String(error)
        persist()
        pause(file.error)
        break
      }
      if (file.phase === 'success') {
        progress.completedFiles++
        progress.uploadedBytes = state.files
          .slice(0, index + 1)
          .reduce((sum, value) => sum + (value.phase === 'success' ? value.size : 0), 0)
      }
    }
    if (state.files.every((file) => file.phase === 'success')) {
      progress.phase = 'completed'
      progress.error = null
    } else if (progress.phase !== 'paused') progress.phase = 'paused'
    report({ ...progress })
    return this.result(state)
  }

  private result(state: FirstShareState, allowComplete = true): OrgKnowledgeShareResult {
    return {
      shareId: state.shareId ? encodeOrgId(state.shareId) : '',
      completion: allowComplete && state.files.every((file) => file.phase === 'success') ? 'completed' : 'incomplete',
      files: state.files.map((file) => ({
        fileName: file.fileName,
        status:
          file.phase === 'success'
            ? 'success'
            : file.phase === 'failure' || file.phase === 'pending'
              ? 'failure'
              : 'unknown',
        fileId: file.fileId ? encodeOrgId(file.fileId) : null,
        chunkCount: null,
        error: file.error
      }))
    }
  }
}
