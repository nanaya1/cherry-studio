import * as z from 'zod'

import { encodeOrgId, type OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'

import { OrgApiHttpError } from './OrgApiClient'

export const firstShareStateSchema = z.object({
  name: z.string(),
  taskId: z.string().optional(),
  purpose: z.enum(['first', 'append']).optional(),
  createdByTask: z.string().optional(),
  cleanup: z
    .object({
      phase: z.enum(['pending', 'intent', 'unknown', 'deleted']),
      error: z.string().nullable()
    })
    .optional(),
  creation: z.enum(['intent', 'unknown', 'created']),
  uploadOriginal: z.boolean().optional(),
  shareId: z.string().nullable(),
  folders: z
    .array(
      z.object({
        itemId: z.string(),
        fileName: z.string(),
        parentItemId: z.string().nullable(),
        folderId: z.string().nullable(),
        phase: z.enum(['pending', 'intent', 'unknown', 'failure', 'success']),
        error: z.string().nullable()
      })
    )
    .optional(),
  files: z.array(
    z.object({
      itemId: z.string(),
      parentItemId: z.string().nullable().optional(),
      fileName: z.string(),
      size: z.number(),
      hash: z.string(),
      fingerprint: z.string(),
      phase: z.enum(['pending', 'intent', 'unknown', 'failure', 'success']),
      fileId: z.string().nullable(),
      error: z.string().nullable(),
      // MEA:enterprise-knowledge-page 记录首传模式，恢复时与本地选项比对，防止错模式恢复。
      uploadOriginal: z.boolean().optional()
    })
  )
})
export type FirstShareState = z.infer<typeof firstShareStateSchema>
export type FirstShareFolder = { itemId: string; fileName: string; parentItemId: string | null }
export type FirstSharePlan = { files: FirstShareEntry[]; folders: FirstShareFolder[] }
export type FirstShareEntry = {
  parentItemId?: string | null
  parentId?: string | null
  itemId: string
  fileName: string
  path: string
  size: number
  hash: string
  fingerprint: string
  chunks: unknown[]
  // MEA:enterprise-knowledge-page 可选不上传源文件：缺省（undefined/true）发送原件字节；false 仅发送元数据。
  uploadOriginal?: boolean
}
export type FirstShareProgress = {
  uploadOriginal?: boolean
  // phase: 'counting' | 'uploading' | 'confirming' | 'paused' | 'completed' | 'cleanup_pending' | 'cleanup_unknown'
  phase:
    | 'preparing'
    | 'counting'
    | 'uploading'
    | 'confirming'
    | 'paused'
    | 'completed'
    | 'cleanup_pending'
    | 'cleanup_unknown'
  totalBytes: number
  uploadedBytes: number
  completedFiles: number
  totalFiles: number
  currentFile: string | null
  error: string | null
}
type Store = { get(key: string): FirstShareState | undefined; set(key: string, state: FirstShareState): void }
type Client = {
  createShareSpace(name: string, uploadOriginal: boolean): Promise<{ share_id: string }>
  verifyPolicy(shareId: string, uploadOriginal: boolean, createdNow?: boolean): Promise<void>
  createShareFolder(
    shareId: string,
    folder: FirstShareFolder,
    parentId: string | null
  ): Promise<{ folder_id: string; name: string; space_id: string; parent_id?: string | null }>
  verifyFolder(shareId: string, folderId: string, folder: FirstShareFolder, parentId: string | null): Promise<void>
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
    // plan: () => Promise<FirstShareEntry[]>,
    plan: () => Promise<FirstShareEntry[] | FirstSharePlan>,
    report: (state: FirstShareProgress) => void,
    active: () => void,
    verifyOnly = false,
    uploadOriginal = true
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
    // const entries = (await plan()).sort((a, b) => a.itemId.localeCompare(b.itemId))
    const planned = await plan()
    const entries = (Array.isArray(planned) ? planned : planned.files).sort((a, b) => a.itemId.localeCompare(b.itemId))
    const folders = Array.isArray(planned) ? [] : [...planned.folders].sort((a, b) => a.itemId.localeCompare(b.itemId))
    const ordered: FirstShareFolder[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const byId = new Map(folders.map((folder) => [folder.itemId, folder]))
    const visit = (folder: FirstShareFolder) => {
      if (visited.has(folder.itemId)) return
      if (visiting.has(folder.itemId)) throw new Error('本地目录存在循环')
      visiting.add(folder.itemId)
      if (folder.parentItemId) {
        const parent = byId.get(folder.parentItemId)
        if (!parent) throw new Error('本地父目录缺失')
        visit(parent)
      }
      visiting.delete(folder.itemId)
      visited.add(folder.itemId)
      ordered.push(folder)
    }
    folders.forEach(visit)
    for (const entry of entries)
      if (entry.parentItemId && !byId.has(entry.parentItemId)) throw new Error('文件父目录缺失')
    active()
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    // MEA:enterprise-knowledge-page 暂不设置客户端总容量上限，旧检查保留供回溯。
    // if (totalBytes >= 2 ** 31) throw new Error('知识库原文件总大小必须严格小于 2 GiB')
    // if (totalBytes >= 20 * 1024 * 1024) throw new Error('知识库原文件总大小必须严格小于 20 MiB')
    // if (!entries.length) throw new Error('该知识库没有可分享文件')
    // if (!entries.length && !folders.length) throw new Error('该知识库没有可分享文件')
    let createdNow = false
    let state = this.store.get(key)
    const persist = () => this.store.set(key, state!)
    if (!state && verifyOnly) throw new Error('没有可核对的上传任务')
    if (!state) {
      state = {
        name,
        creation: 'intent',
        uploadOriginal: entries[0]?.uploadOriginal ?? uploadOriginal,
        shareId: null,
        folders: folders.map((folder) => ({ ...folder, folderId: null, phase: 'pending', error: null })),
        files: entries.map((entry) => ({
          itemId: entry.itemId,
          parentItemId: entry.parentItemId ?? null,
          fileName: entry.fileName,
          size: entry.size,
          hash: entry.hash,
          fingerprint: entry.fingerprint,
          phase: 'pending',
          fileId: null,
          error: null,
          // MEA:enterprise-knowledge-page 持久首传模式：缺省按上传原件处理，保证恢复不漂移。
          uploadOriginal: entry.uploadOriginal ?? true
        }))
      }
      persist()
      try {
        active()
        // const created = await this.client.createShareSpace(name)
        const created = await this.client.createShareSpace(name, state.uploadOriginal!)
        state.shareId = created.share_id
        state.creation = 'created'
        createdNow = true
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
      (state.folders ?? []).length !== folders.length ||
      (state.folders ?? []).some(
        (folder, index) =>
          folder.itemId !== folders[index]?.itemId ||
          folder.fileName !== folders[index]?.fileName ||
          folder.parentItemId !== folders[index]?.parentItemId
      ) ||
      state.files.some((file, index) => (file.parentItemId ?? null) !== (entries[index]?.parentItemId ?? null)) ||
      state.files.length !== entries.length ||
      state.files.some(
        (file, index) =>
          file.itemId !== entries[index]?.itemId ||
          file.fingerprint !== entries[index]?.fingerprint ||
          file.fileName !== entries[index]?.fileName ||
          // (file.uploadOriginal ?? true) !== (entries[index]?.uploadOriginal ?? true)
          (file.uploadOriginal ?? state.uploadOriginal) !== (entries[index]?.uploadOriginal ?? true)
      )
    ) {
      pause('本地文件已变化，请恢复原文件后核对，或联系管理员核查。')
      return this.result(state, false)
    }
    try {
      const mode = state.uploadOriginal ?? entries[0]?.uploadOriginal
      if (typeof mode !== 'boolean') throw new Error('首传模式未知，请核查空间策略')
      await this.client.verifyPolicy(state.shareId, mode, createdNow)
      active()
      state.uploadOriginal = mode
      persist()
    } catch (error) {
      pause(error instanceof Error ? error.message : String(error))
      return this.result(state, false)
    }
    // MEA:enterprise-knowledge-page 父目录先建并核对；未知创建结果禁止按同名认领或重放。
    const remoteFolders = new Map<string, string>()
    for (const folder of ordered) {
      active()
      const saved = state.folders!.find((value) => value.itemId === folder.itemId)!
      const parentId = folder.parentItemId ? remoteFolders.get(folder.parentItemId)! : null
      progress.currentFile = folder.fileName
      try {
        if (!saved.folderId) {
          // 旧客户端把明确未匹配路由的404存为unknown，可在保留空间记录下重试。
          if (saved.phase === 'unknown' && saved.error === '接口不存在') saved.phase = 'failure'
          if (saved.phase === 'intent' || saved.phase === 'unknown')
            throw new Error('目录创建结果未知且没有可信ID，禁止自动重建，请联系管理员核查。')
          if (verifyOnly) {
            pause('目录尚未上传，请继续上传。')
            return this.result(state, false)
          }
          saved.phase = 'intent'
          saved.error = null
          persist()
          active()
          progress.phase = 'uploading'
          report({ ...progress })
          const created = await this.client.createShareFolder(state.shareId, folder, parentId)
          if (
            created.space_id !== state.shareId ||
            created.name !== folder.fileName.trim() ||
            (created.parent_id ?? null) !== parentId ||
            !created.folder_id
          )
            throw new Error('目录创建响应未确认')
          saved.folderId = created.folder_id
          persist()
          active()
        }
        progress.phase = 'confirming'
        report({ ...progress })
        await this.client.verifyFolder(state.shareId, saved.folderId, folder, parentId)
        active()
        saved.phase = 'success'
        saved.error = null
        persist()
        remoteFolders.set(folder.itemId, saved.folderId)
      } catch (error) {
        saved.phase =
          // 原明确失败条件：!saved.folderId && error instanceof OrgApiHttpError && [401, 403, 422].includes(error.status)
          !saved.folderId &&
          error instanceof OrgApiHttpError &&
          ([401, 403, 422].includes(error.status) || (error.status === 404 && error.message === '接口不存在'))
            ? 'failure'
            : 'unknown'
        saved.error = error instanceof Error ? error.message : String(error)
        persist()
        pause(saved.error)
        return this.result(state, false)
      }
    }
    for (const [index, file] of state.files.entries()) {
      active()
      // const entry = entries[index]
      const entry = {
        ...entries[index],
        parentId: entries[index].parentItemId ? remoteFolders.get(entries[index].parentItemId)! : null
      }
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
          try {
            await this.client.verifyPolicy(state.shareId, entry.uploadOriginal ?? state.uploadOriginal)
            active()
          } catch (error) {
            pause(error instanceof Error ? error.message : String(error))
            return this.result(state, false)
          }
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
      // completion: allowComplete && state.files.every((file) => file.phase === 'success') ? 'completed' : 'incomplete',
      completion:
        allowComplete &&
        state.creation === 'created' &&
        Boolean(state.shareId) &&
        (state.folders ?? []).every((folder) => folder.phase === 'success') &&
        state.files.every((file) => file.phase === 'success')
          ? 'completed'
          : 'incomplete',
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
