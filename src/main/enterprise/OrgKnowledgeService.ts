import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
// import { basename } from 'node:path'
import { basename, extname, join } from 'node:path'

import { fileTypeFromBuffer } from 'file-type'

import { application } from '@application'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'
import { loggerService } from '@logger'
import { KeyedMutex } from '@main/core/concurrency/KeyedMutex'
import type { JobManager } from '@main/core/job/JobManager'
import type { JobContext, JobSettledEvent } from '@main/core/job/types'
import type { Disposable } from '@main/core/lifecycle'
import {
  OrgKnowledgeCreateShareInputSchema,
  OrgKnowledgeReceiveShareInputSchema,
  type OrgKnowledgeCollaboratorList,
  type OrgKnowledgeShare,
  type OrgKnowledgeCatalog,
  type OrgKnowledgeChunkPage,
  type OrgKnowledgeInvitationList,
  type OrgKnowledgeItemPage,
  type OrgKnowledgeMember,
  type OrgKnowledgeMemberList,
  type OrgKnowledgePreview,
  type OrgKnowledgeReadResult,
  type OrgKnowledgeSearchResult,
  type OrgKnowledgeShareResult,
  type OrgKnowledgeSyncPreview,
  type OrgKnowledgeSyncStatus,
  type OrgKnowledgeSyncApply,
  type OrgKnowledgeSyncChange,
  type OrgKnowledgeSyncManifest,
  encodeOrgId,
  isOrgId,
  parseOrgId
} from '@shared/data/types/enterpriseKnowledge'
// import type { KnowledgeItemChunk } from '@shared/data/types/knowledge'
import type {
  KnowledgeAddConflictStrategy,
  KnowledgeAddItemInput,
  KnowledgeAddItemsResult,
  KnowledgeItemChunk
} from '@shared/data/types/knowledge'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'
import { AbsoluteFilePathSchema, type AbsoluteFilePath } from '@shared/types/file'
import { sanitizeFilename } from '@shared/utils/file'

import { CloudKnowledgeRecovery, type RecoveryFile } from './CloudKnowledgeRecovery'
// import { FirstShareUpload, type FirstShareEntry, type FirstShareProgress } from './FirstShareUpload'
import {
  FirstShareUpload,
  type FirstShareEntry,
  type FirstShareProgress,
  type FirstSharePlan
} from './FirstShareUpload'
import {
  captureKnowledgeSourceBindings,
  removeKnowledgeSourceBindings,
  replaceKnowledgeSourceBindings
} from './KnowledgeSourceBindings'
import { OrgApiHttpError } from './OrgApiClient'
import type { OrgAuthManager } from './OrgAuthManager'
import { OrgKnowledgeClient, OrgKnowledgeProtocolError } from './OrgKnowledgeClient'
import { orgStateStore } from './OrgStateStore'

type Lease = ReturnType<OrgAuthManager['acquireLease']>
type ShareEntry = { itemId: string; fileName: string; buffer: Buffer; chunks: unknown[] }
type SyncPlan = {
  key: string
  baseId: string
  lease: Lease
  fingerprint: string
  expiresAt: number
  changes: OrgKnowledgeSyncChange[]
  cleanupOnly?: boolean
}
type SyncJobInput = { plan: SyncPlan; confirmDeletes: boolean }
type ShareJobInput = { localBaseId: string; key: string; lease: Lease }

const logger = loggerService.withContext('OrgKnowledgeService')
// const AUTO_SYNC_DELAY_MS = 1_000
/* 原自动同步任务类型保留。
const KNOWLEDGE_JOB_TYPES = new Set([
  'knowledge.prepare-root',
  'knowledge.index-documents',
  'knowledge.check-file-processing-result',
  'knowledge.delete-subtree',
  'knowledge.reindex-subtree'
])
*/

declare module '@main/core/job/jobRegistry' {
  interface JobRegistry {
    'enterprise.knowledge-sync': SyncJobInput
    'enterprise.knowledge-share': ShareJobInput
  }
}

export class OrgKnowledgeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OrgKnowledgeError'
  }
}

export class OrgKnowledgeService {
  private readonly client: OrgKnowledgeClient
  private readonly shareMutex = new KeyedMutex()
  // private jobs!: Pick<JobManager, 'registerHandler' | 'enqueue' | 'list' | 'onJobSettled'>
  private readonly syncPlans = new Map<string, SyncPlan>()
  private readonly syncing = new Set<string>()
  // MEA:enterprise-knowledge-page 取消分享期间同步占位：阻止 share/invite/createShareCode/syncApply/syncPreview 对同一 space 的并发写。
  private readonly unsharing = new Set<string>()
  private readonly autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly automaticAdditions = new Map<string, { baseId: string; localBaseId: string; lease: Lease }>()
  private jobs!: Pick<JobManager, 'list'>
  private jobSettledSubscription?: Disposable
  private disposed = false
  private firstShareActive?: { key: string; name: string; promise: Promise<OrgKnowledgeShareResult>; stop: () => void }
  private readonly firstShareProgress = new Map<string, FirstShareProgress>()

  initialize(jobs: Pick<JobManager, 'registerHandler' | 'enqueue' | 'list' | 'onJobSettled'>): void {
    // this.jobs = jobs
    this.jobs = jobs
    this.disposed = false
    this.jobSettledSubscription?.dispose()
    this.jobSettledSubscription = jobs.onJobSettled((event) => this.onJobSettled(event))
    jobs.registerHandler('enterprise.knowledge-sync', {
      // MEA:enterprise-knowledge-page 写请求结果未知时禁止任务重放。
      recovery: 'abandon',
      execute: async (ctx) =>
        this.shareMutex.runExclusive(ctx.input.plan.key, async () => {
          try {
            this.syncing.add(ctx.input.plan.key)
            // return await this.executeSync(ctx.input, ctx.signal)
            void this.executeSync
            throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '旧本地推送已停用')
          } finally {
            this.syncing.delete(ctx.input.plan.key)
          }
        })
    })
    jobs.registerHandler('enterprise.knowledge-share', {
      // MEA:enterprise-knowledge-page 中断后不恢复上传，业务关联仍是幂等与失败阻断的唯一依据。
      recovery: 'abandon',
      execute: async (ctx) => {
        const { localBaseId, key, lease } = ctx.input
        try {
          return await this.shareMutex.runExclusive(key, () =>
            this.checked(() => this.createShare(localBaseId, key, lease, ctx), lease)
          )
        } catch (error) {
          if (error instanceof OrgKnowledgeError) await ctx.patchMetadata({ errorCode: error.code })
          throw error
        }
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.firstShareActive?.stop()
    this.jobSettledSubscription?.dispose()
    this.jobSettledSubscription = undefined
    for (const timer of this.autoSyncTimers.values()) clearTimeout(timer)
    this.autoSyncTimers.clear()
    this.automaticAdditions.clear()
  }

  private scheduleAddition(key: string): void {
    if (this.disposed || !this.automaticAdditions.has(key)) return
    const previous = this.autoSyncTimers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.autoSyncTimers.delete(key)
      void this.runAddition(key).catch((error: unknown) => {
        const pending = this.automaticAdditions.get(key)
        this.automaticAdditions.delete(key)
        this.firstShareProgress.set(key, {
          phase: 'paused',
          totalBytes: 0,
          uploadedBytes: 0,
          completedFiles: 0,
          totalFiles: 0,
          currentFile: null,
          error: error instanceof Error ? error.message : String(error)
        })
        logger.warn('automatic knowledge addition stopped', { baseId: pending?.localBaseId, error: String(error) })
      })
    }, 1000)
    timer.unref()
    this.autoSyncTimers.set(key, timer)
  }

  private async runAddition(key: string): Promise<void> {
    const pending = this.automaticAdditions.get(key)
    if (this.disposed || !pending) return
    this.assertLease(pending.lease)
    const activeJobs = await this.jobs.list({
      queue: `base.${pending.localBaseId}`,
      status: ['pending', 'running'],
      limit: 1
    })
    this.assertLease(pending.lease)
    if (this.disposed || this.automaticAdditions.get(key) !== pending) return
    if (activeJobs.length || this.firstShareActive) {
      this.scheduleAddition(key)
      return
    }
    this.automaticAdditions.delete(key)
    this.firstShareProgress.set(key, {
      phase: 'counting',
      totalBytes: 0,
      uploadedBytes: 0,
      completedFiles: 0,
      totalFiles: 0,
      currentFile: null,
      error: null
    })
    await this.uploadAddedFiles(pending.baseId, pending.localBaseId)
  }

  private onJobSettled(event: JobSettledEvent): void {
    if (
      !this.disposed &&
      ['completed', 'failed', 'cancelled'].includes(event.status) &&
      ['knowledge.prepare-root', 'knowledge.index-documents', 'knowledge.check-file-processing-result'].includes(
        event.type
      )
    ) {
      const baseId = (event.input as { baseId?: string }).baseId
      for (const [key, pending] of this.automaticAdditions) {
        if (pending.localBaseId === baseId) this.scheduleAddition(key)
      }
    }
    // MEA:enterprise-knowledge-page 本地任务不再调度云端写入，保留旧实现供回溯。
    void event
    /*
    if (this.disposed || event.status !== 'completed' || !KNOWLEDGE_JOB_TYPES.has(event.type)) return
    const baseId = (event.input as { baseId?: unknown }).baseId
    if (typeof baseId !== 'string' || !baseId) return
    let lease: Lease
    try {
      lease = this.acquireLease()
    } catch {
      return
    }
    const key = this.syncKey(baseId, lease)
    if (!orgStateStore.getShareAssociation(key)) return
    this.scheduleAutoSync(baseId, key)
    */
  }

  /* 原自动同步调度与执行保留，禁止本地变更覆盖云端。
  private scheduleAutoSync(baseId: string, key: string): void {
    if (this.disposed) return
    const current = this.autoSyncTimers.get(key)
    if (current) clearTimeout(current)
    const timer = setTimeout(() => {
      this.autoSyncTimers.delete(key)
      void this.runAutoSync(baseId, key).catch((error: unknown) => {
        logger.warn('automatic knowledge sync stopped', { baseId, error: String(error) })
      })
    }, AUTO_SYNC_DELAY_MS)
    timer.unref()
    this.autoSyncTimers.set(key, timer)
  }

  private async runAutoSync(baseId: string, key: string): Promise<void> {
    if (this.disposed) return
    const lease = this.acquireLease()
    if (this.syncKey(baseId, lease) !== key || !orgStateStore.getShareAssociation(key)) return
    const hasActiveJobs = async () =>
      (
        await this.jobs.list({
          queue: `base.${baseId}`,
          status: ['pending', 'running'],
          limit: 1
        })
      ).length > 0
    if (await hasActiveJobs()) {
      this.scheduleAutoSync(baseId, key)
      return
    }
    const preview = await this.syncPreview({ baseId })
    if (this.disposed || preview.status !== 'pending' || !preview.changes.length) return
    if (preview.changes.some((change) => change.kind === 'delete')) return
    if (await hasActiveJobs()) {
      this.scheduleAutoSync(baseId, key)
      return
    }
    if (this.disposed) return
    await this.syncApply({ baseId, planId: preview.planId, confirmDeletes: false })
  }

  */

  constructor(private readonly auth: OrgAuthManager) {
    // this.client = new OrgKnowledgeClient(auth.apiClient)
    this.client = new OrgKnowledgeClient(auth.apiClient, () => {
      const lease = this.acquireLease()
      return (session) => {
        this.assertLease(lease)
        if (
          session &&
          (session.issuerId !== lease.issuerId || session.userId !== lease.userId || session.groupId !== lease.groupId)
        )
          throw new OrgKnowledgeError(E.ORGKB_UNAUTHORIZED, '写入凭据与原操作身份不匹配')
      }
    })
  }

  private acquireLease(): Lease {
    try {
      return this.auth.acquireLease()
    } catch {
      throw new OrgKnowledgeError(E.ORGKB_UNAUTHORIZED, '组织账号会话不可用')
    }
  }

  private assertLease(lease: Lease): void {
    try {
      this.auth.assertLease(lease)
    } catch {
      throw new OrgKnowledgeError(E.ORGKB_UNAUTHORIZED, '组织账号已切换或会话失效')
    }
  }

  private async checked<T>(operation: () => Promise<T>, lease = this.acquireLease()): Promise<T> {
    this.assertLease(lease)
    try {
      return await operation()
    } finally {
      this.assertLease(lease)
    }
  }

  private decodeId(id: string, what: string): string {
    const raw = parseOrgId(id)
    if (raw === null) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, `非法的组织知识库${what}: ${id}`)
    return raw
  }

  async catalog(): Promise<OrgKnowledgeCatalog> {
    const lease = this.acquireLease()
    const raw = await this.checked(() => this.client.getCatalog(), lease)
    const associations = orgStateStore.getShareAssociations()
    const localBaseId = (spaceId: string) => {
      for (const [key, association] of Object.entries(associations)) {
        if (association.shareId !== spaceId) continue
        try {
          const [issuerId, userId, groupId, baseId] = JSON.parse(key)
          if (
            issuerId === lease.issuerId &&
            userId === lease.userId &&
            groupId === lease.groupId &&
            typeof baseId === 'string'
          )
            return baseId
        } catch {
          continue
        }
      }
      return undefined
    }
    const toBase = (b: {
      id: string
      name: string
      description?: string | null
      updated_at?: string
      document_count?: number
      allow_local_file_upload?: boolean
      can_download?: boolean
    }) => ({
      id: encodeOrgId(b.id),
      name: b.name,
      description: b.description ?? null,
      updatedAt: b.updated_at,
      documentCount: b.document_count,
      allowLocalFileUpload: b.allow_local_file_upload,
      canDownload: b.can_download
    })
    const owned = raw.owned.map((base) => {
      const id = localBaseId(base.id)
      const association = id ? associations[this.syncKey(id, lease)] : undefined
      return {
        ...toBase(base),
        localBaseId: id,
        shareCompleted: association?.completion === 'completed',
        hasShareEvidence: undefined as boolean | undefined
      }
    })
    // owned 归属由 catalog 上游校验；最多两个库、四个请求并发，普通失败只使证据未知。
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(2, owned.length) }, async () => {
        while (next < owned.length) {
          const index = next++
          const base = owned[index]
          if (base.shareCompleted) {
            base.hasShareEvidence = true
            continue
          }
          base.hasShareEvidence = await this.catalogShareEvidence(raw.owned[index].id, lease)
        }
      })
    )
    this.assertLease(lease)
    return {
      public: raw.public.map(toBase),
      shared: raw.shared.map(toBase),
      owned
    }
  }

  private async catalogShareEvidence(spaceId: string, lease: Lease): Promise<boolean | undefined> {
    const query = async (operation: () => Promise<boolean>): Promise<boolean | undefined> => {
      try {
        return await this.checked(operation, lease)
      } catch (error) {
        this.assertLease(lease)
        if (
          (error instanceof OrgKnowledgeError && error.code === E.ORGKB_UNAUTHORIZED) ||
          (error instanceof OrgApiHttpError && error.status === 401)
        )
          throw error
        logger.warn('catalog share evidence unavailable', {
          reason: error instanceof OrgApiHttpError ? error.status : 'network-or-protocol'
        })
        return undefined
      }
    }
    const [shares, members] = await Promise.all([
      query(async () => {
        const records = await this.client.listShares(spaceId, AbortSignal.timeout(5_000))
        if (records.some((share) => share.space_id !== spaceId))
          throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '分享空间不匹配')
        return records.some(
          (share) =>
            share.share_type === 1 &&
            !share.revoked_at &&
            (!share.expires_at || Date.parse(share.expires_at) > Date.now()) &&
            (share.max_views === null || share.view_count < share.max_views)
        )
      }),
      query(async () => {
        const records = await this.client.listMembers(spaceId, AbortSignal.timeout(5_000))
        // members 的 viewer 与有效状态可证指定人分享；不将 owner/本人或未知角色计为证据。
        return records.some(
          (member) =>
            String(member.user_id) !== lease.userId &&
            member.role === 'viewer' &&
            isLiveMemberStatus(member.status) &&
            (!member.expires_at || Date.parse(member.expires_at) > Date.now())
        )
      })
    ])
    if (shares === true || members === true) return true
    return shares === false && members === false ? false : undefined
  }

  async listItems(baseId: string, cursor?: string | null): Promise<OrgKnowledgeItemPage> {
    const rawBase = this.decodeId(baseId, 'baseId')
    const lease = this.acquireLease()
    const raw = await this.checked(() => this.client.listItems(rawBase, cursor), lease)
    const fileIds = new Map<string, string>()
    const originals = new Map<string, boolean | undefined>()
    for (const item of raw.items) {
      if (!['file', 'directory'].includes(item.type) || item.base_id !== rawBase) continue
      try {
        const fileId =
          typeof item.data.file_id === 'string' && item.data.file_id
            ? item.data.file_id
            : item.type === 'directory'
              ? item.id
              : item.document_id
                ? await this.checked(() => this.client.resolveFileId(item.document_id!), lease)
                : null
        if (!fileId) continue
        const file = await this.checked(() => this.client.getFile(fileId), lease)
        if (file.id !== fileId || file.space_id !== rawBase || file.is_dir !== (item.type === 'directory')) continue
        fileIds.set(item.id, fileId)
        originals.set(item.id, file.has_original_file)
      } catch (error) {
        const optionalFailure =
          error instanceof OrgKnowledgeProtocolError ||
          (error instanceof OrgApiHttpError && [403, 404, 422, 500, 502, 503, 504].includes(error.status))
        if (!optionalFailure) throw error
        logger.warn('knowledge item file metadata unavailable', {
          reason: error instanceof OrgApiHttpError ? error.status : 'protocol'
        })
      }
    }
    return {
      items: raw.items.map((it) => ({
        id: encodeOrgId(it.id),
        baseId: encodeOrgId(it.base_id),
        type: it.type,
        title: it.title,
        status: it.status,
        parentId: it.group_id ? encodeOrgId(it.group_id) : null,
        documentId: it.document_id ? encodeOrgId(it.document_id) : null,
        hasOriginalFile: originals.get(it.id),
        fileId: fileIds.has(it.id) ? encodeOrgId(fileIds.get(it.id)!) : null,
        createdAt: it.created_at,
        updatedAt: it.updated_at
      })),
      total: raw.total,
      nextCursor: raw.next_cursor ?? null
    }
  }

  async listDirectoryItems(
    baseId: string,
    cursor?: string | null,
    parentId?: string | null
  ): Promise<OrgKnowledgeItemPage> {
    const rawBase = this.decodeId(baseId, 'baseId')
    const lease = this.acquireLease()
    const rawParent = parentId ? this.decodeId(parentId, 'parentId') : null
    const pageNumber = cursor ? Number(cursor) : 1
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '非法目录分页')
    const page = await this.checked(() => this.client.listSpaceFiles(rawBase, rawParent, pageNumber), lease)
    if (page.folders.some((file) => file.space_id !== rawBase || file.parent_id !== rawParent))
      throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '目录文件归属不匹配')
    if (page.files.some((file) => file.space_id !== rawBase || file.parent_id !== rawParent))
      throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '目录文件归属不匹配')
    const byFileId = new Map<string, Awaited<ReturnType<OrgKnowledgeClient['listItems']>>['items'][number]>()
    let itemCursor: string | null | undefined
    const seenItemCursors = new Set<string>()
    do {
      const itemPage = await this.checked(() => this.client.listItems(rawBase, itemCursor), lease)
      for (const item of itemPage.items) {
        const fileId = typeof item.data.file_id === 'string' && item.data.file_id ? item.data.file_id : item.document_id
        if (fileId) byFileId.set(fileId, item)
      }
      itemCursor = itemPage.next_cursor
      if (itemCursor) {
        if (seenItemCursors.has(itemCursor)) throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '知识条目分页未确认')
        seenItemCursors.add(itemCursor)
      }
    } while (itemCursor)
    const entries = [...page.folders, ...page.files]
    return {
      items: entries.map((file) => {
        const item = byFileId.get(file.id)
        return {
          id: encodeOrgId(item?.id ?? file.id),
          baseId: encodeOrgId(rawBase),
          type: file.is_dir ? 'directory' : 'file',
          title: file.name,
          status: item?.status ?? 'completed',
          parentId: file.parent_id ? encodeOrgId(file.parent_id) : null,
          documentId: item?.document_id ? encodeOrgId(item.document_id) : file.is_dir ? null : encodeOrgId(file.id),
          hasOriginalFile: file.has_original_file,
          fileId: encodeOrgId(file.id),
          createdAt: item?.created_at ?? file.updated_at,
          updatedAt: file.updated_at
        }
      }),
      total: page.total,
      nextCursor: entries.length < page.total ? String(pageNumber + 1) : null
    }
  }

  async listChunks(baseId: string, itemId: string, cursor?: string | null): Promise<OrgKnowledgeChunkPage> {
    const rawBase = this.decodeId(baseId, 'baseId')
    const rawItem = this.decodeId(itemId, 'itemId')
    const raw = await this.checked(() => this.client.listChunks(rawBase, rawItem, cursor))
    return {
      chunks: raw.chunks.map((c) => ({
        id: encodeOrgId(c.chunk_id),
        itemId: encodeOrgId(c.item_id),
        documentId: encodeOrgId(c.document_id),
        content: c.content,
        chunkIndex: c.metadata.chunk_index,
        metadata: c.metadata
      })),
      total: raw.total,
      nextCursor: raw.next_cursor ?? null
    }
  }

  async search(params: {
    baseIds: string[]
    query: string
    topK?: number
    rerank?: boolean
  }): Promise<OrgKnowledgeSearchResult> {
    const rawBases = params.baseIds.map((id) => this.decodeId(id, 'baseId'))
    const raw = await this.checked(() => this.client.search({ ...params, baseIds: rawBases }))
    return {
      chunks: raw.chunks.map((c) => ({
        chunkId: encodeOrgId(c.chunk_id),
        baseId: encodeOrgId(c.base_id),
        documentId: encodeOrgId(c.document_id),
        title: c.title,
        content: c.content,
        score: c.score
      }))
    }
  }

  async read(params: { baseId: string; documentId: string; chunkId?: string | null }): Promise<OrgKnowledgeReadResult> {
    const baseId = this.decodeId(params.baseId, 'baseId')
    const documentId = this.decodeId(params.documentId, 'documentId')
    const chunkId = params.chunkId ? this.decodeId(params.chunkId, 'chunkId') : null
    const raw = await this.checked(() => this.client.read({ baseId, documentId, chunkId }))
    return {
      documentId: encodeOrgId(raw.document_id),
      title: raw.title,
      content: raw.content,
      totalChars: raw.total_chars ?? null,
      truncated: raw.truncated
    }
  }

  async deleteFile(params: { baseId: string; fileId: string }): Promise<{ ok: true }> {
    const spaceId = this.decodeId(params.baseId, 'baseId')
    const fileId = this.decodeId(params.fileId, 'fileId')
    const lease = this.acquireLease()
    await this.assertRealOwner(spaceId, lease)
    const file = await this.checked(() => this.client.getFile(fileId), lease)
    if (file.id !== fileId || file.space_id !== spaceId)
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '文件不属于当前知识库')
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '该云端库已进入恢复流程，不能删除资料')
    await this.checked(() => this.client.deleteFile(fileId), lease)
    return { ok: true }
  }

  async preview(params: { fileId: string }): Promise<OrgKnowledgePreview> {
    const fileId = this.decodeId(params.fileId, 'fileId')
    const lease = this.acquireLease()
    const file = await this.checked(() => this.client.getFile(fileId), lease)
    if (file.id !== fileId || file.is_dir || file.has_original_file !== true)
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '原件不可用或能力已变化')
    const preview = await this.checked(() => this.client.getPreviewUrl(fileId), lease).catch((error) => {
      if (error instanceof OrgApiHttpError && error.status === 409)
        throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '原件不可用或能力已变化')
      throw error
    })
    const mimeType = preview.mime_type?.split(';')[0].trim().toLowerCase() ?? null
    logger.info('knowledge preview metadata', { fileId: params.fileId, kind: preview.kind, mimeType })
    const inlineTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/bmp'
    ]
    let previewUrl: string | undefined
    if (preview.kind === 'inline' && preview.url) {
      const parsed = new URL(preview.url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '预览地址无效')
      }
      previewUrl = parsed.href
    }
    // PDF 交给应用内 PDF.js；仅图片直接引用临时地址。
    if (previewUrl && mimeType && mimeType !== 'application/pdf' && inlineTypes.includes(mimeType)) {
      return { kind: 'inline', fileName: preview.file_name, mimeType, content: '', url: previewUrl }
    }
    const officePreview: Record<string, readonly [string, number]> = {
      '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 25 * 1024 * 1024],
      '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20 * 1024 * 1024],
      '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 25 * 1024 * 1024]
    }
    const office = officePreview[extname(preview.file_name).toLowerCase()]
    if (preview.kind === 'inline' && office) {
      const officeMimeType = office[0]
      if (previewUrl) {
        const bytes = await this.checked(() => this.client.fetchPresignedPreviewBytes(previewUrl, office[1]), lease)
        return {
          kind: 'inline',
          fileName: preview.file_name,
          mimeType: officeMimeType,
          content: '',
          base64: bytes.toString('base64')
        }
      }
      // return { kind: 'inline', fileName: preview.file_name, mimeType: officeMimeType, content: '' }
      // 无原件地址时继续使用下方鉴权解析正文分支。
    }
    // if (preview.kind === 'inline' && !mimeType) {
    if (preview.kind === 'inline' && (!mimeType || mimeType === 'application/octet-stream')) {
      const expectedMime = new Map([
        ['.pdf', 'application/pdf'],
        ['.png', 'image/png'],
        ['.jpg', 'image/jpeg'],
        ['.jpeg', 'image/jpeg'],
        ['.gif', 'image/gif'],
        ['.webp', 'image/webp'],
        ['.avif', 'image/avif'],
        ['.bmp', 'image/bmp']
      ]).get(extname(preview.file_name).toLowerCase())
      if (expectedMime) {
        const bytes = await this.checked(() => this.client.fetchPreviewBytes(fileId), lease)
        // 只补全缺失的 MIME，文件名和二进制签名必须一致。
        const detected = await fileTypeFromBuffer(bytes).catch(() => undefined)
        logger.info('knowledge preview MIME detection', {
          fileId: params.fileId,
          expectedMime,
          detectedMime: detected?.mime ?? null,
          matched: detected?.mime === expectedMime
        })
        if (detected?.mime === expectedMime) {
          return {
            kind: 'inline',
            fileName: preview.file_name,
            mimeType: detected.mime,
            content: '',
            ...(previewUrl && detected.mime !== 'application/pdf'
              ? { url: previewUrl }
              : { base64: bytes.toString('base64') })
          }
        }
      }
    }
    if (
      // (preview.kind === 'inline' && /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(preview.file_name)) ||
      (preview.kind === 'inline' && /\.(docx?|xlsx?|pptx?|odt|ods|odp|epub)$/i.test(preview.file_name)) ||
      preview.kind === 'text' ||
      // (preview.kind === 'inline' && (mimeType?.startsWith('text/') || mimeType === 'application/json'))
      // Markdown 原件可能缺少 MIME 或被对象存储标为通用二进制。
      (preview.kind === 'inline' &&
        (mimeType?.startsWith('text/') ||
          mimeType === 'application/json' ||
          mimeType === 'application/markdown' ||
          // ((!mimeType || mimeType === 'application/octet-stream') && /\.(md|markdown)$/i.test(preview.file_name))))
          ((!mimeType || mimeType === 'application/octet-stream') &&
            /\.(txt|md|markdown|mdx|csv|html?|draftsexport)$/i.test(preview.file_name))))
    ) {
      const content = await this.checked(() => this.client.fetchPreviewContent(fileId), lease)
      return { kind: 'text', fileName: preview.file_name, mimeType, content }
    }
    if (
      preview.kind === 'inline' &&
      mimeType &&
      ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(
        mimeType
      )
    ) {
      const bytes = await this.checked(() => this.client.fetchPreviewBytes(fileId), lease)
      return { kind: 'inline', fileName: preview.file_name, mimeType, content: '', base64: bytes.toString('base64') }
    }
    return { kind: preview.kind, fileName: preview.file_name, mimeType, content: '' }
  }

  async shares(params: { baseId: string }): Promise<{ shares: OrgKnowledgeShare[] }> {
    const spaceId = this.decodeId(params.baseId, 'baseId')
    const raw = await this.checked(() => this.client.listShares(spaceId))
    if (raw.some((share) => share.space_id !== spaceId)) throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '分享空间不匹配')
    return { shares: raw.map(toShare) }
  }

  async createShareCode(params: {
    baseId: string
    password?: string
    maxViews?: number
    expireDays: number | null
  }): Promise<OrgKnowledgeShare> {
    if (!OrgKnowledgeCreateShareInputSchema.safeParse(params).success)
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '分享设置无效')
    const spaceId = this.decodeId(params.baseId, 'baseId')
    const lease = this.acquireLease()
    const catalog = await this.checked(() => this.client.getCatalog(), lease)
    const owned = catalog.owned.find((space) => space.id === spaceId)
    if (
      catalog.public.some((space) => space.id === spaceId) ||
      !owned ||
      !(owned.my_role === 'owner' || (owned.owner_id !== undefined && String(owned.owner_id) === lease.userId))
    ) {
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '仅允许分享本人拥有的非公共知识库')
    }
    const associations = Object.entries(orgStateStore.getShareAssociations()).filter(([key, value]) => {
      if (value.shareId !== spaceId || value.pendingAddition) return false
      try {
        const [issuerId, userId] = JSON.parse(key)
        return issuerId === lease.issuerId && userId === lease.userId
      } catch {
        return false
      }
    })
    // 跨端 owner 管理已有云端库无需本机关联，已知未完成的上传仍在下方拦截。
    // if (associations.length === 0) throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '仅允许分享本地已关联的知识库')
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '该知识库正在取消分享')
    if (
      associations.some(
        ([, value]) =>
          value.completion !== 'completed' ||
          !value.files.length ||
          value.files.some((file) => file.status !== 'success')
      )
    ) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_INCOMPLETE, '内容副本未完整上传或状态未确认')
    }
    // MEA:enterprise-knowledge-page 取消分享期间拒绝新建分享码，避免 DELETE 与创建竞争同一 space。
    if (associations.some(([key]) => this.unsharing.has(key))) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试')
    }
    const raw = await this.checked(async () => {
      try {
        // return await this.client.createShareCode(spaceId, params)
        // return await this.shareMutex.runExclusive(associations[0][0], () => {
        return await this.shareMutex.runExclusive(recoveryKey, () => {
          if (
            this.unsharing.has(recoveryKey) ||
            orgStateStore.getCloudRecovery(recoveryKey) ||
            associations.some(([key]) => this.unsharing.has(key) || !orgStateStore.getShareAssociations()[key])
          )
            throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '共享状态已变化，请刷新后再试')
          return this.client.createShareCode(spaceId, params)
        })
      } catch (error) {
        if (error instanceof OrgApiHttpError && error.status < 500) throw error
        throw new OrgKnowledgeError(E.ORGKB_SHARE_CREATE_UNKNOWN, '创建分享码结果未知，请刷新分享列表核查后再操作')
      }
    }, lease)
    if (raw.space_id !== spaceId || raw.share_type !== 1)
      throw new OrgKnowledgeError(E.ORGKB_SHARE_CREATE_UNKNOWN, '创建分享码响应异常，请刷新分享列表核查')
    return toShare(raw)
  }

  async revokeShare(params: { baseId: string; shareId: string }): Promise<{ ok: true }> {
    const spaceId = this.decodeId(params.baseId, 'baseId')
    const shareId = this.decodeId(params.shareId, 'shareId')
    await this.checked(() => this.client.revokeShare(spaceId, shareId))
    return { ok: true }
  }

  async receiveShare(params: { shareCode: string; password?: string }): Promise<{ baseId: string; name: string }> {
    if (!OrgKnowledgeReceiveShareInputSchema.safeParse(params).success)
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '分享码或提取码格式无效')
    const raw = await this.checked(() => this.client.receiveShare(params))
    return { baseId: encodeOrgId(raw.id), name: raw.name }
  }

  async members(params: { baseId: string }): Promise<OrgKnowledgeMemberList> {
    const spaceId = this.decodeId(params.baseId, 'baseId')
    const raw = await this.checked(() => this.client.listMembers(spaceId))
    return { members: raw.map(toMember) }
  }

  async collaborators(params: {
    keyword?: string
    page?: number
    pageSize?: number
  }): Promise<OrgKnowledgeCollaboratorList> {
    const lease = this.acquireLease()
    const raw = await this.checked(() => this.client.listCollaborators(params), lease)
    // [enterprise] 过滤本人：邀请列表不应包含当前登录用户；total 直接回传服务端真实计数，不虚构/扣减。
    const selfId = lease.userId
    const items = raw.items.filter((collaborator) => String(collaborator.id) !== selfId)
    return { items, total: raw.total, page: raw.page, pageSize: raw.pageSize }
  }

  async invite(params: { baseId: string; userId: number; expireDays?: number }): Promise<OrgKnowledgeMember> {
    // if (isOrgId(params.baseId)) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '邀请仅支持本地知识库')
    const remote = isOrgId(params.baseId)
    if (
      !Number.isSafeInteger(params.userId) ||
      params.userId <= 0 ||
      (params.expireDays !== undefined &&
        (!Number.isInteger(params.expireDays) || params.expireDays < 1 || params.expireDays > 30))
    )
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '邀请用户或有效天数无效')
    // 解析本地已完成的可信关联（副本已上传确认），不允许未关联或未完成即邀请。
    const lease = this.acquireLease()
    // MEA:enterprise-knowledge-page 取消分享期间拒绝邀请，避免 DELETE 与添加成员竞争同一 space。
    if (!remote && this.unsharing.has(this.syncKey(params.baseId, lease))) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试')
    }
    // 与共享状态使用同一身份上下文的关联键，避免误判已共享的本地库。
    // const association = orgStateStore.getShareAssociation(params.baseId)
    // const association = orgStateStore.getShareAssociation(this.syncKey(params.baseId, lease))
    const association = remote ? undefined : orgStateStore.getShareAssociation(this.syncKey(params.baseId, lease))
    // if (!association || association.completion !== 'completed') {
    if (!remote && (!association || association.completion !== 'completed')) {
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '该本地知识库尚未完成共享关联，无法邀请')
    }
    // const spaceId = association.shareId
    const spaceId = remote ? this.decodeId(params.baseId, 'baseId') : association!.shareId
    const associations = Object.entries(orgStateStore.getShareAssociations()).filter(([key, value]) => {
      if (value.shareId !== spaceId || value.pendingAddition) return false
      try {
        const [issuerId, userId] = JSON.parse(key)
        return issuerId === lease.issuerId && userId === lease.userId
      } catch {
        return false
      }
    })
    if (
      associations.some(
        ([, value]) => value.completion !== 'completed' || value.files.some((file) => file.status !== 'success')
      )
    )
      throw new OrgKnowledgeError(E.ORGKB_SHARE_INCOMPLETE, '内容副本未完整上传或状态未确认')
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '该知识库正在取消分享')
    // owner 校验：必须为本账号拥有的非公共空间（复用同步 owner 校验）。
    await this.syncOwner(spaceId, lease)
    if (
      !Number.isSafeInteger(params.userId) ||
      params.userId <= 0 ||
      (params.expireDays !== undefined &&
        (!Number.isInteger(params.expireDays) || params.expireDays < 1 || params.expireDays > 30))
    ) {
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '邀请用户或有效天数无效')
    }
    // 不能邀请本人。
    if (String(params.userId) === lease.userId) {
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '不能邀请本人')
    }
    // 拉取最新 members，阻止仍生效（active/pending 等）的重复邀请；expired/removed 按实际契约放行。
    const members = await this.checked(() => this.client.listMembers(spaceId), lease)
    const existing = members.find((member) => member.user_id === params.userId)
    if (existing && isLiveMemberStatus(existing.status)) {
      throw new OrgKnowledgeError(E.ORGKB_MEMBER_EXISTS, '该用户已是成员或邀请待处理，不能重复邀请')
    }
    // return toMember(await this.checked(() => this.client.addMember(spaceId, params.userId, params.expireDays), lease))
    // const key = this.syncKey(params.baseId, lease)
    const key = remote ? (associations[0]?.[0] ?? recoveryKey) : this.syncKey(params.baseId, lease)
    // 与云端取消流程使用同一空间锁，避免请求发出后再并发删除。
    return this.shareMutex.runExclusive(recoveryKey, async () => {
      // if (this.unsharing.has(key) || orgStateStore.getShareAssociation(key)?.shareId !== spaceId)
      if (
        this.unsharing.has(key) ||
        this.unsharing.has(recoveryKey) ||
        orgStateStore.getCloudRecovery(recoveryKey) ||
        (!remote && orgStateStore.getShareAssociation(key)?.shareId !== spaceId) ||
        associations.some(
          ([associationKey]) =>
            this.unsharing.has(associationKey) || !orgStateStore.getShareAssociations()[associationKey]
        )
      )
        throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '共享状态已变化，请刷新后再试')
      return toMember(await this.checked(() => this.client.addMember(spaceId, params.userId, params.expireDays), lease))
    })
  }

  async invitations(): Promise<OrgKnowledgeInvitationList> {
    const raw = await this.checked(() => this.client.listInvitations())
    return {
      invitations: raw.map((inv) => ({
        id: encodeOrgId(inv.id),
        spaceId: encodeOrgId(inv.space_id),
        name: inv.name,
        inviter: inv.inviter == null ? null : String(inv.inviter),
        role: inv.role,
        expires: inv.expires
      }))
    }
  }

  async accept(params: { invitationId: string }): Promise<OrgKnowledgeMember> {
    const id = this.decodeId(params.invitationId, 'invitationId')
    return toMember(await this.checked(() => this.client.acceptInvitation(id)))
  }

  async decline(params: { invitationId: string }): Promise<{ ok: true }> {
    const id = this.decodeId(params.invitationId, 'invitationId')
    await this.checked(() => this.client.declineInvitation(id))
    return { ok: true }
  }

  async removeMember(params: { baseId: string; userId: number }): Promise<{ ok: true }> {
    const spaceId = this.decodeId(params.baseId, 'baseId')
    await this.checked(() => this.client.removeMember(spaceId, params.userId))
    return { ok: true }
  }

  private syncKey(baseId: string, lease: Lease): string {
    if (!baseId || baseId.startsWith('orgkb:')) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '需要本地知识库 ID')
    return JSON.stringify([lease.issuerId, lease.userId, lease.groupId, baseId])
  }

  async syncStatus({ baseId }: { baseId: string }): Promise<OrgKnowledgeSyncStatus> {
    const lease = this.acquireLease()
    const association = orgStateStore.getShareAssociation(this.syncKey(baseId, lease))
    this.assertLease(lease)
    if (!association) return { state: 'unshared', lastSyncedAt: null }
    if (!association.manifest) return { state: 'unconfirmed', lastSyncedAt: null }
    const manifest = association.manifest
    if (this.syncing.has(this.syncKey(baseId, lease))) return { state: 'syncing', lastSyncedAt: manifest.lastSyncedAt }
    if (manifest.operations.some((op) => !['complete', 'failure'].includes(op.phase)))
      return { state: 'unknown', lastSyncedAt: manifest.lastSyncedAt }
    if (manifest.state === 'shared') {
      const entries = await this.localSyncEntries(baseId, lease)
      if (this.diffSync(entries, manifest).length) return { state: 'pending', lastSyncedAt: manifest.lastSyncedAt }
    }
    return { state: manifest.state, lastSyncedAt: manifest.lastSyncedAt }
  }

  async syncPreview({ baseId }: { baseId: string }): Promise<OrgKnowledgeSyncPreview> {
    const lease = this.acquireLease()
    // MEA:enterprise-knowledge-page 取消分享期间拒绝构建同步计划，避免基于即将删除的 space 提交写。
    if (this.unsharing.has(this.syncKey(baseId, lease))) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试')
    }
    const association = orgStateStore.getShareAssociation(this.syncKey(baseId, lease))
    if (!association) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地知识库尚未共享')
    this.assertLease(lease)
    const planId = randomUUID()
    const result: OrgKnowledgeSyncPreview = {
      planId,
      baseId,
      shareId: encodeOrgId(association.shareId),
      status: 'unconfirmed',
      changes: [],
      warnings: ['缺少可信文件映射，不能推断远端文件归属']
    }
    const manifest = association.manifest
    if (!manifest || manifest.entries.some((entry) => !entry.fileId)) return result
    const unfinished = manifest.operations.filter((op) => !['complete', 'failure'].includes(op.phase))
    const cleanupOnly =
      unfinished.length > 0 &&
      unfinished.every(
        (op) =>
          op.phase === 'cleanup_pending' && (op.kind === 'delete' || (op.kind === 'update' && op.newFileId && op.hash))
      )
    if (unfinished.length && !cleanupOnly)
      return { ...result, status: 'unknown', warnings: ['存在结果未知操作，仅可查询核查，禁止自动重传'] }
    if (association.completion !== 'completed' && manifest.state === 'incomplete')
      return { ...result, status: 'incomplete', warnings: ['初次共享未完整确认，需核查恢复记录'] }
    await this.syncOwner(association.shareId, lease)
    const entries = await this.localSyncEntries(baseId, lease)
    const changes = cleanupOnly
      ? unfinished.map(({ itemId, fileName, kind, remoteFileId }) => ({ itemId, fileName, kind, remoteFileId }))
      : this.diffSync(entries, manifest)
    for (const [id, plan] of this.syncPlans) if (plan.expiresAt <= Date.now()) this.syncPlans.delete(id)
    this.syncPlans.set(planId, {
      key: this.syncKey(baseId, lease),
      baseId,
      lease,
      changes,
      cleanupOnly,
      fingerprint: this.syncFingerprint(entries, association),
      expiresAt: Date.now() + 5 * 60_000
    })
    return {
      ...result,
      status: changes.length ? 'pending' : 'shared',
      changes,
      warnings: cleanupOnly
        ? ['仅清理已记录旧副本，不重复上传；DELETE 为软删除，索引失效时间未承诺']
        : changes.some((change) => change.kind === 'delete' || change.kind === 'update')
          ? ['更新为非原子操作，新副本验证后软删除旧版；目录不可见不代表索引即时失效，索引失效时间未承诺']
          : []
      // 原失败提示：DELETE 仅承诺软删除，索引失效无可验证契约；保留旧副本，不发送删除请求
    }
  }

  private async localSyncEntries(baseId: string, lease: Lease): Promise<ShareEntry[]> {
    const ks = application.get('KnowledgeService')
    const bases = ks.listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [baseId] } })
    if (!bases.items.some((base) => base.id === baseId))
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地知识库不存在')
    return this.checked(() => this.buildSharePlan(ks, baseId), lease)
  }

  private entryHash(entry: ShareEntry): string {
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical)
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonical(child)])
        )
      return value
    }
    const chunks = entry.chunks.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return createHash('sha256').update(entry.buffer).update('\u0000').update(JSON.stringify(chunks)).digest('hex')
  }

  private syncFingerprint(entries: ShareEntry[], association: OrgKnowledgeShareResult): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          association,
          entries: entries.map((entry) => [entry.itemId, entry.fileName, this.entryHash(entry)]).sort()
        })
      )
      .digest('hex')
  }

  private diffSync(entries: ShareEntry[], manifest: OrgKnowledgeSyncManifest): OrgKnowledgeSyncChange[] {
    const changes: OrgKnowledgeSyncChange[] = []
    for (const entry of entries) {
      const old = manifest.entries.find((candidate) => candidate.itemId === entry.itemId)
      const kind = !old
        ? 'add'
        : old.hash !== this.entryHash(entry)
          ? 'update'
          : old.fileName !== entry.fileName
            ? 'rename'
            : null
      if (kind)
        changes.push({
          itemId: entry.itemId,
          fileName: entry.fileName,
          kind,
          remoteFileId: old?.fileId ? encodeOrgId(old.fileId) : null
        })
    }
    for (const old of manifest.entries)
      if (!entries.some((entry) => entry.itemId === old.itemId))
        changes.push({
          itemId: old.itemId,
          fileName: old.fileName,
          kind: 'delete',
          remoteFileId: old.fileId ? encodeOrgId(old.fileId) : null
        })
    return changes
  }

  private async syncOwner(shareId: string, lease: Lease): Promise<void> {
    const catalog = await this.checked(() => this.client.getCatalog(), lease)
    const owned = catalog.owned.find((space) => space.id === shareId)
    if (
      catalog.public.some((space) => space.id === shareId) ||
      !owned ||
      !(owned.my_role === 'owner' || (owned.owner_id !== undefined && String(owned.owner_id) === lease.userId))
    )
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '仅允许同步本人拥有的关联空间')
  }

  async syncApply({
    baseId,
    planId,
    confirmDeletes
  }: {
    baseId: string
    planId: string
    confirmDeletes: boolean
  }): Promise<OrgKnowledgeSyncApply> {
    // MEA:enterprise-knowledge-page 旧 manifest 推送可能删除云端新资料，统一拒绝。
    void baseId
    void planId
    void confirmDeletes
    throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '旧本地推送已停用，请在云端详情新增文件')
    /* 原手动同步提交保留。
    const lease = this.acquireLease()
    // MEA:enterprise-knowledge-page 取消分享期间拒绝提交同步，避免 DELETE 与同步写竞争同一 space。
    if (this.unsharing.has(this.syncKey(baseId, lease))) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试')
    }
    const plan = this.syncPlans.get(planId)
    this.syncPlans.delete(planId)
    if (
      !plan ||
      plan.baseId !== baseId ||
      plan.key !== this.syncKey(baseId, lease) ||
      JSON.stringify(plan.lease) !== JSON.stringify(lease) ||
      plan.expiresAt <= Date.now()
    )
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '同步计划已失效，请重新预览')
    if (plan.changes.some((change) => change.kind === 'delete') && confirmDeletes !== true)
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '需要确认本批次删除')
    const job = await this.jobs.enqueue('enterprise.knowledge-sync', { plan, confirmDeletes }, { maxAttempts: 1 })
    const result = await job.finished
    this.assertLease(lease)
    if (result.status !== 'completed')
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, result.error?.message ?? '同步任务未完成')
    return result.output as OrgKnowledgeSyncApply
    */
  }

  private async executeSync(
    { plan, confirmDeletes }: SyncJobInput,
    signal: AbortSignal
  ): Promise<OrgKnowledgeSyncApply> {
    const { lease, key, baseId } = plan
    const active = () => {
      signal.throwIfAborted()
      this.assertLease(lease)
    }
    active()
    if (plan.expiresAt <= Date.now()) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '同步计划已过期')
    const association = orgStateStore.getShareAssociation(key)
    const entries = await this.localSyncEntries(baseId, lease)
    if (!association?.manifest || this.syncFingerprint(entries, association) !== plan.fingerprint)
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地内容或共享状态已变化，请重新预览')
    await this.syncOwner(association.shareId, lease)
    const manifest = association.manifest
    const files: OrgKnowledgeSyncApply['files'] = []
    const persist = () => {
      active()
      association.completion = manifest.state === 'shared' ? 'completed' : 'incomplete'
      orgStateStore.setShareAssociation(key, association)
      active()
    }
    for (const change of plan.changes) {
      active()
      const entry = entries.find((candidate) => candidate.itemId === change.itemId)
      const old = manifest.entries.find((candidate) => candidate.itemId === change.itemId)
      const pendingOperation = plan.cleanupOnly
        ? manifest.operations.find((op) => op.itemId === change.itemId && op.phase === 'cleanup_pending')
        : undefined
      const operation: OrgKnowledgeSyncManifest['operations'][number] = pendingOperation ?? {
        ...change,
        newFileId: null,
        hash: entry ? this.entryHash(entry) : null,
        phase: 'writing',
        error: null
      }
      /* 原失败分支保留：实际同步改用下方软删除与目录核查。
      if (change.kind === 'delete') {
        // MEA:enterprise-knowledge-page 只读核查旧副本；搜索无命中不能替代索引失效契约。
        let observation = '旧副本目录/检索状态未确认'
        try {
          const page = await this.checked(() => this.client.listItems(association.shareId), lease)
          const search = await this.checked(
            () => this.client.search({ baseIds: [association.shareId], query: change.fileName, topK: 50 }),
            lease
          )
          const oldId = old?.fileId
          const visible =
            page.items.some((item) => item.data.file_id === oldId || item.document_id === oldId) ||
            search.chunks.some((chunk) => chunk.document_id === oldId)
          observation = visible ? '旧副本仍可见' : '本次目录/检索未命中旧副本，仍不能证明全索引失效'
        } catch {
          active()
        }
        files.push({
          itemId: change.itemId,
          fileName: change.fileName,
          kind: change.kind,
          status: 'failure',
          error: `索引失效契约未确认，保留旧副本；${observation}`
        })
        continue
      }
      */
      if (change.kind === 'delete' && !confirmDeletes)
        throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '需要确认本批次删除')
      if (plan.cleanupOnly && !pendingOperation) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '清理记录已变化')
      if (change.kind !== 'add' && (!old?.fileId || change.remoteFileId !== encodeOrgId(old.fileId)))
        throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '远端文件映射未确认')
      if (!pendingOperation) manifest.operations.push(operation)
      manifest.state = 'syncing'
      persist()
      let status: 'success' | 'failure' | 'unknown' = 'unknown'
      try {
        if (old?.fileId && !pendingOperation) {
          const remote = await this.checked(() => this.client.getFile(old.fileId!), lease)
          if (remote.id !== old.fileId || remote.space_id !== association.shareId || remote.is_dir)
            throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '远端文件不属于关联空间')
        }
        if (pendingOperation || change.kind === 'delete') {
          if (change.kind === 'update') {
            if (!operation.newFileId || operation.newFileId === old!.fileId)
              throw new Error('新旧文件映射未确认，禁止删除')
            const replacement = await this.checked(() => this.client.getFile(operation.newFileId!), lease)
            if (
              replacement.id !== operation.newFileId ||
              replacement.space_id !== association.shareId ||
              replacement.is_dir
            )
              throw new Error('新副本归属未确认，禁止清理')
          }
          operation.phase = 'cleanup_pending'
          persist()
          await this.cleanupSyncFile(association.shareId, old!.fileId!, lease, active)
          if (change.kind === 'delete') {
            manifest.entries = manifest.entries.filter((candidate) => candidate !== old)
          } else {
            old!.fileId = operation.newFileId!
            old!.fileName = operation.fileName
            old!.hash = operation.hash!
          }
        } else if (change.kind === 'rename') {
          const renamed = await this.checked(() => this.client.renameFile(old!.fileId!, change.fileName), lease)
          if (
            renamed.id !== old!.fileId ||
            renamed.space_id !== association.shareId ||
            renamed.name !== change.fileName ||
            renamed.is_dir
          )
            throw new Error('重命名结果未确认')
          old!.fileName = change.fileName
        } else {
          const form = new FormData()
          form.append('file', new Blob([new Uint8Array(entry!.buffer)]), entry!.fileName)
          // form.append('chunks', JSON.stringify(entry!.chunks))
          form.append(
            'chunks_file',
            new Blob([JSON.stringify(entry!.chunks)], { type: 'application/json' }),
            'chunks.json'
          )
          const uploaded = await this.checked(() => this.client.uploadShareFile(association.shareId, form), lease)
          operation.newFileId = uploaded.file_id
          operation.phase = 'verifying'
          persist()
          if (uploaded.share_id !== association.shareId || uploaded.chunk_count !== entry!.chunks.length)
            throw new Error('上传响应未确认')
          await this.verifySyncFile(association.shareId, uploaded.file_id, entry!, lease)
          if (change.kind === 'update') {
            operation.phase = 'cleanup_pending'
            // operation.error = '新副本可查询，旧副本索引失效契约未确认，保留旧新映射'
            if (uploaded.file_id === old!.fileId) throw new Error('新旧文件 ID 相同，禁止删除')
            persist()
            await this.cleanupSyncFile(association.shareId, old!.fileId!, lease, active)
            old!.fileId = uploaded.file_id
            old!.fileName = entry!.fileName
            old!.hash = operation.hash!
          } else {
            manifest.entries.push({
              itemId: entry!.itemId,
              fileId: uploaded.file_id,
              fileName: entry!.fileName,
              hash: this.entryHash(entry!)
            })
          }
        }
        // 原失败判断：if (operation.phase !== 'cleanup_pending')
        operation.phase = 'complete'
        operation.error = null
        status = 'success'
      } catch (error) {
        active()
        operation.error = error instanceof Error ? error.message : String(error)
        // MEA:enterprise-knowledge-page 5xx/断网/协议错误均可能已写入，不能自动再次上传。
        if (
          (error instanceof OrgApiHttpError && error.status >= 400 && error.status < 500) ||
          (error instanceof OrgKnowledgeError && error.code === E.ORGKB_FORBIDDEN)
        ) {
          if (operation.phase !== 'cleanup_pending' && !operation.newFileId) operation.phase = 'failure'
          if (operation.phase === 'failure' || operation.phase === 'cleanup_pending') status = 'failure'
        }
      }
      manifest.state = status === 'unknown' ? 'unknown' : 'pending'
      persist()
      files.push({
        itemId: change.itemId,
        fileName: change.fileName,
        kind: change.kind,
        status,
        error: operation.error
      })
    }
    const status = files.some((file) => file.status === 'unknown')
      ? 'unknown'
      : files.some((file) => file.status === 'failure')
        ? 'partial'
        : 'complete'
    manifest.state = status === 'complete' ? 'shared' : status === 'unknown' ? 'unknown' : 'failed'
    if (status === 'complete') manifest.lastSyncedAt = new Date().toISOString()
    association.files = manifest.entries.map((entry) => ({
      fileName: entry.fileName,
      fileId: entry.fileId ? encodeOrgId(entry.fileId) : null,
      status: status === 'complete' ? 'success' : 'unknown',
      chunkCount: null,
      error: status === 'complete' ? null : '同步未完整确认'
    }))
    persist()
    return { status, files, shareId: encodeOrgId(association.shareId) }
  }

  private async cleanupSyncFile(shareId: string, fileId: string, lease: Lease, active: () => void): Promise<void> {
    active()
    await this.syncOwner(shareId, lease)
    let exists = true
    try {
      const file = await this.checked(() => this.client.getFile(fileId), lease)
      if (file.id !== fileId || file.space_id !== shareId || file.is_dir)
        throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '远端文件不属于关联空间')
    } catch (error) {
      if (!(error instanceof OrgApiHttpError) || error.status !== 404) throw error
      exists = false
    }
    active()
    if (exists) await this.checked(() => this.client.deleteFile(fileId), lease)
    let cursor: string | null | undefined
    const seen = new Set<string>()
    do {
      active()
      const page = await this.checked(() => this.client.listItems(shareId, cursor), lease)
      for (const item of page.items) {
        if (item.base_id !== shareId) throw new Error('目录空间归属未确认')
        if (item.id === fileId || item.data.file_id === fileId || item.document_id === fileId)
          throw new Error('软删除后旧文件仍在目录中可见')
        if (item.type === 'file' && !item.data.file_id && item.document_id) {
          const resolved = await this.checked(() => this.client.resolveFileId(item.document_id!), lease)
          if (!resolved || resolved === fileId) throw new Error('目录文件映射未确认')
        }
      }
      cursor = page.next_cursor
      if (cursor && seen.has(cursor)) throw new Error('目录分页未确认')
      if (cursor) seen.add(cursor)
    } while (cursor)
    // 这里只核查目录不可见；软删除不代表搜索索引即时失效。
  }

  private async verifySyncFile(shareId: string, fileId: string, entry: ShareEntry, lease: Lease): Promise<void> {
    const file = await this.checked(() => this.client.getFile(fileId), lease)
    if (
      file.id !== fileId ||
      file.space_id !== shareId ||
      file.is_dir ||
      file.name !== entry.fileName ||
      file.file_hash !== createHash('sha256').update(entry.buffer).digest('hex')
    )
      throw new Error('文件元信息或哈希未确认')
    let cursor: string | null | undefined
    const seen = new Set<string>()
    do {
      const page = await this.checked(() => this.client.listItems(shareId, cursor), lease)
      const item = page.items.find(
        (candidate) =>
          candidate.base_id === shareId &&
          candidate.type === 'file' &&
          (candidate.data.file_id === fileId || candidate.document_id === fileId)
      )
      if (item) {
        const visible = await this.checked(() => this.client.getItem(shareId, item.id), lease)
        if (
          visible.id !== item.id ||
          visible.base_id !== shareId ||
          visible.status !== 'completed' ||
          !(visible.data.file_id === fileId || visible.document_id === fileId)
        )
          throw new Error('知识条目未确认')
        const chunks = await this.checked(() => this.client.listChunks(shareId, item.id), lease)
        if (
          chunks.total !== entry.chunks.length ||
          !chunks.chunks.length ||
          chunks.chunks.some((chunk) => chunk.item_id !== item.id)
        )
          throw new Error('知识分块未确认')
        return
      }
      cursor = page.next_cursor
      if (cursor && seen.has(cursor)) throw new Error('目录分页未确认')
      if (cursor) seen.add(cursor)
    } while (cursor)
    throw new Error('新文件尚未出现在知识目录')
  }

  async prepareAddedFiles(baseId: string): Promise<{ localBaseId: string }> {
    if (this.firstShareActive) throw new Error(`「${this.firstShareActive.name}」正在上传云端，请完成后再试`)
    const lease = this.acquireLease()
    const spaceId = this.decodeId(baseId, '知识库')
    await this.assertRealOwner(spaceId, lease)
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new Error('该云端库已进入恢复流程，不能新增资料')
    const ks = application.get('KnowledgeService')
    for (const [key, association] of Object.entries(orgStateStore.getShareAssociations())) {
      // 原仅复用未完成暂存库；追加现在复用对应的本地副本。
      // if (association.shareId !== spaceId || !association.pendingAddition || association.completion === 'completed') continue
      if (association.shareId !== spaceId) continue
      const [issuerId, userId, groupId, localBaseId] = JSON.parse(key)
      if (
        issuerId !== lease.issuerId ||
        userId !== lease.userId ||
        groupId !== lease.groupId ||
        typeof localBaseId !== 'string'
      )
        continue
      const pendingBase = ks
        .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
        .items.find((base) => base.id === localBaseId)
      this.assertLease(lease)
      if (pendingBase) {
        // 仅准备本地关联，实际提交资料后再登记自动追加。
        // this.automaticAdditions.set(key, { baseId, localBaseId, lease })
        return { localBaseId }
      }
    }
    // const base = await ks.createBase({ name: '云端新增资料（仅本机待上传）', embeddingModelId: null, dimensions: null })
    const space = await this.checked(() => this.client.getSpace(spaceId), lease)
    const base = await ks.createBase({ name: space.name, embeddingModelId: null, dimensions: null })
    this.assertLease(lease)
    orgStateStore.setShareAssociation(this.syncKey(base.id, lease), {
      shareId: spaceId,
      completion: 'incomplete',
      pendingAddition: true,
      files: []
    })
    // this.automaticAdditions.set(this.syncKey(base.id, lease), { baseId, localBaseId: base.id, lease })
    return { localBaseId: base.id }
  }

  async addFiles(
    baseId: string,
    localBaseId: string,
    items: KnowledgeAddItemInput[],
    conflictStrategy?: KnowledgeAddConflictStrategy
  ): Promise<KnowledgeAddItemsResult> {
    if (this.firstShareActive) throw new Error(`「${this.firstShareActive.name}」正在上传云端，请完成后再试`)
    const lease = this.acquireLease()
    const spaceId = this.decodeId(baseId, '知识库')
    await this.assertRealOwner(spaceId, lease)
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new Error('该云端库已进入恢复流程，不能新增资料')
    const key = this.syncKey(localBaseId, lease)
    if (orgStateStore.getShareAssociation(key)?.shareId !== spaceId) throw new Error('找不到可信的本机新增资料关联')
    const result = await application.get('KnowledgeService').addItems(localBaseId, items, conflictStrategy)
    this.assertLease(lease)
    if (result.status === 'added') {
      this.automaticAdditions.set(key, { baseId, localBaseId, lease })
      // 主进程主动调度，避免解析任务已结束或详情关闭时丢失启动信号。
      this.scheduleAddition(key)
    }
    return result
  }

  async uploadAddedFiles(
    baseId: string,
    localBaseId: string,
    _uploadOriginal?: boolean
  ): Promise<OrgKnowledgeShareResult> {
    const lease = this.acquireLease()
    const spaceId = this.decodeId(baseId, '知识库')
    await this.assertRealOwner(spaceId, lease)
    const space = await this.checked(() => this.client.getSpace(spaceId), lease)
    if (space.id !== spaceId || typeof space.allow_local_file_upload !== 'boolean')
      throw new Error('空间源文件上传策略未确认')
    const uploadOriginal = space.allow_local_file_upload
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new Error('该云端库已进入恢复流程，不能新增资料')
    const key = this.syncKey(localBaseId, lease)
    const association = orgStateStore.getShareAssociation(key)
    if (association?.shareId !== spaceId) throw new Error('找不到可信的本机新增资料关联')
    if (this.firstShareActive) {
      if (this.firstShareActive.key === key) return this.firstShareActive.promise
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, `「${this.firstShareActive.name}」正在上传云端，请完成后再试`)
    }
    const saved = orgStateStore.getFirstShareUpload(key)
    if (!saved && association.completion === 'completed' && !association.pendingAddition)
      throw new Error('本地副本缺少可信的已上传文件记录，请先核对历史上传结果')
    const finished =
      saved?.creation === 'created' &&
      saved.files.every((file) => file.phase === 'success') &&
      (saved.folders ?? []).every((folder) => folder.phase === 'success')
    if (!saved || finished) {
      const plan = await this.buildFirstSharePlan(
        application.get('KnowledgeService'),
        localBaseId,
        () => this.assertLease(lease),
        uploadOriginal
      )
      this.assertLease(lease)
      if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
        throw new Error('该云端库已进入恢复流程，不能新增资料')
      orgStateStore.setFirstShareUpload(key, {
        name: '云端新增资料',
        purpose: 'append',
        uploadOriginal,
        creation: 'created',
        shareId: spaceId,
        folders: plan.folders.map((folder) => {
          const previous = saved?.folders?.find((entry) => entry.itemId === folder.itemId)
          return previous ?? { ...folder, folderId: null, phase: 'pending', error: null }
        }),
        files: plan.files.map((file) => ({
          itemId: file.itemId,
          parentItemId: file.parentItemId ?? null,
          fileName: file.fileName,
          size: file.size,
          hash: file.hash,
          fingerprint: file.fingerprint,
          phase: 'pending',
          fileId: null,
          error: null,
          uploadOriginal,
          ...saved?.files.find((entry) => entry.itemId === file.itemId && entry.fingerprint === file.fingerprint)
        }))
      })
      // 已共享库的授权完成态不因本批追加而回退。
      if (association.pendingAddition)
        orgStateStore.setShareAssociation(key, { ...association, completion: 'incomplete' })
    }
    if (this.unsharing.has(recoveryKey) || orgStateStore.getCloudRecovery(recoveryKey))
      throw new Error('该云端库已进入恢复流程，不能新增资料')
    return this.share(localBaseId, false, uploadOriginal)
  }

  async uploadStatus(baseId: string): Promise<FirstShareProgress | null> {
    const lease = this.acquireLease()
    const key = this.syncKey(baseId, lease)
    if (this.automaticAdditions.has(key))
      return {
        // phase: 'counting',
        phase: 'preparing',
        totalBytes: 0,
        uploadedBytes: 0,
        completedFiles: 0,
        totalFiles: 0,
        currentFile: null,
        error: null
      }
    let cleanupState = orgStateStore.getFirstShareUpload(key)
    if (!this.firstShareActive && cleanupState && !cleanupState.cleanup && !orgStateStore.getShareAssociation(key)) {
      cleanupState.cleanup = { phase: 'pending', error: '首次分享任务已中断' }
      orgStateStore.setFirstShareUpload(key, cleanupState)
    }
    if (
      !this.firstShareActive &&
      cleanupState?.cleanup &&
      orgStateStore.getShareAssociation(key)?.completion !== 'completed'
    ) {
      await this.shareMutex.runExclusive(key, () => this.rollbackFirstShare(key, baseId, lease))
      cleanupState = orgStateStore.getFirstShareUpload(key)
    }
    if (cleanupState?.cleanup && orgStateStore.getShareAssociation(key)?.completion !== 'completed')
      return {
        phase:
          cleanupState.cleanup.phase === 'unknown' || cleanupState.cleanup.phase === 'intent'
            ? 'cleanup_unknown'
            : 'cleanup_pending',
        totalBytes: 0,
        uploadedBytes: 0,
        completedFiles: 0,
        totalFiles: cleanupState.files.length,
        currentFile: null,
        error: cleanupState.cleanup.error,
        uploadOriginal: cleanupState.uploadOriginal
      }
    const progress = this.firstShareProgress.get(key)
    if (progress) return { ...progress, uploadOriginal: orgStateStore.getFirstShareUpload(key)?.uploadOriginal }
    const saved = orgStateStore.getFirstShareUpload(key)
    if (!saved) {
      const association = orgStateStore.getShareAssociation(key)
      if (!association) return null
      const space = await this.checked(() => this.client.getSpace(association.shareId), lease)
      if (space.id !== association.shareId || typeof space.allow_local_file_upload !== 'boolean')
        throw new Error('空间源文件上传策略未确认')
      return {
        phase: association.completion === 'completed' ? 'completed' : 'paused',
        uploadOriginal: space.allow_local_file_upload,
        totalBytes: 0,
        uploadedBytes: 0,
        completedFiles: 0,
        totalFiles: 0,
        currentFile: null,
        error: null
      }
    }
    return {
      uploadOriginal: saved.uploadOriginal,
      // phase: saved.files.every((file) => file.phase === 'success') ? 'completed' : 'paused',
      phase:
        saved.creation === 'created' &&
        (saved.folders ?? []).every((folder) => folder.phase === 'success') &&
        saved.files.every((file) => file.phase === 'success')
          ? 'completed'
          : 'paused',
      totalBytes: saved.files.reduce((sum, file) => sum + file.size, 0),
      uploadedBytes: saved.files.reduce((sum, file) => sum + (file.phase === 'success' ? file.size : 0), 0),
      completedFiles: saved.files.filter((file) => file.phase === 'success').length,
      totalFiles: saved.files.length,
      currentFile: null,
      error:
        saved.folders?.find((folder) => folder.error)?.error ??
        saved.files.find((file) => file.error)?.error ??
        (saved.creation !== 'created' ? '创建云端库结果未知，请联系管理员核查' : null)
    }
  }

  /**
   * 取消分享（主进程）。本地已分享库取消 = 删除云端 space 后解绑，本地副本保留。
   * 仅允许当前 lease 下已完成的可信关联；无绑定幂等成功（不触碰远端）。取消期间用 unsharing
   * 同步占位 + shareMutex 串行，确保 share/invite/createShareCode/syncApply 不会并发写同一 space。
   * 仅 204 成功后清除本地绑定与首传记录；超时/403/404 保留绑定不假定成功；会话变化不跨账号解绑。
   */
  /* 原直接删除链路保留，取消分享改为先恢复再删除。
  async unshare({ baseId }: { baseId: string }): Promise<{ ok: boolean }> {
    const lease = this.acquireLease()
    const key = this.syncKey(baseId, lease)
    // MEA:enterprise-knowledge-page 取消期间同步占位，拒绝并发新建/同步/邀请对同一 space 的写。
    if (this.unsharing.has(key)) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '该知识库正在取消分享，请稍后再试')
    }
    const association = orgStateStore.getShareAssociation(key)
    // 无绑定：幂等成功，不触碰远端。
    if (!association) return { ok: true }
    if (association.completion !== 'completed') {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_INCOMPLETE, '共享内容尚未完整上传，暂不能取消')
    }
    // 同 key 的上传/同步进行中，拒绝以免 DELETE 与写竞争同一 space。
    if (this.firstShareActive && this.firstShareActive.key === key) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在上传云端副本，请完成后再取消分享')
    }
    if (this.syncing.has(key)) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在同步，请完成后再取消分享')
    }
    // MEA:enterprise-knowledge-page 操作前同步占位，shareMutex 串行确保取消期间无新增写。
    this.unsharing.add(key)
    try {
      return await this.shareMutex.runExclusive(key, async () => {
        // 锁内重读绑定：会话变化或并发取消可能已改变/清除。
        const current = orgStateStore.getShareAssociation(key)
        if (!current || current.completion !== 'completed') return { ok: true }
        // 按真实 owner 取消（允许 public 空间），不依赖同步 owner 校验的 public 拒绝；最小新校验。
        await this.assertRealOwner(current.shareId, lease)
        // 仅 204 成功后清除本地绑定与首传记录；失败（超时/403/404）保留绑定不假定成功。
        // await this.client.deleteShareSpace(current.shareId)
        await this.checked(() => this.client.deleteShareSpace(current.shareId), lease)
        this.clearLocalShare(key)
        return { ok: true }
      })
    } finally {
      this.unsharing.delete(key)
    }
  }

  */

  /**
   * [enterprise] 重命名已分享的本地知识库并同步到云端空间。仅对当前账号下「已绑定」的关联生效，
   * 按 association.shareId 提交改名（绝不按名称认领/查找云端）。无关联时为空操作；取消分享期间
   * 与初传进行中拒绝，避免与 DELETE/上传竞争同一 space。
   */
  async renameSharedBase(baseId: string, name: string): Promise<void> {
    const lease = this.acquireLease()
    let localKey = isOrgId(baseId) ? null : this.syncKey(baseId, lease)
    let remoteBaseId: string | null = isOrgId(baseId) ? this.decodeId(baseId, '知识库') : null
    if (!remoteBaseId && localKey) {
      const association = orgStateStore.getShareAssociation(localKey)
      if (!association) {
        const catalog = await this.checked(() => this.client.getCatalog(), lease)
        if (catalog.owned.some((base) => base.id === baseId)) {
          // 原始云端 UUID 无本机副本时，转为纯远端改名，不能再走本地关联空操作。
          remoteBaseId = baseId
          localKey = null
        }
      }
    }
    const key = localKey ?? JSON.stringify([lease.issuerId, lease.userId, 'remote-rename', baseId])
    if (this.unsharing.has(key)) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试')
    }
    if (localKey && this.firstShareActive?.key === localKey) {
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在上传云端副本，请完成后再试')
    }
    await this.shareMutex.runExclusive(key, async () => {
      this.assertLease(lease)
      const association = localKey ? orgStateStore.getShareAssociation(localKey) : undefined
      const spaceId = association?.shareId ?? remoteBaseId
      if (!spaceId) return
      if (localKey && !association) return
      await this.assertRealOwner(spaceId, lease)
      const result = await this.checked(() => this.client.renameSpace(spaceId, name), lease)
      if (result.id !== spaceId || result.name !== name) {
        throw new OrgKnowledgeError(E.ORGKB_PROTOCOL, '重命名响应异常，已拒绝')
      }
    })
  }

  private recoveryContext(baseId: string, lease: Lease) {
    const remoteId = parseOrgId(baseId)
    const associationKey = remoteId ? undefined : this.syncKey(baseId, lease)
    const association = associationKey ? orgStateStore.getShareAssociation(associationKey) : undefined
    const spaceId = remoteId ?? association?.shareId
    if (!spaceId) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '找不到可信云端关联')
    const key = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    const ks = application.get('KnowledgeService')
    const active = () => this.assertLease(lease)
    const scan = async (): Promise<RecoveryFile[]> => {
      const result: RecoveryFile[] = []
      const seen = new Set<string>()
      const visit = async (parentId: string | null) => {
        let count = 0
        let total = Infinity
        for (let page = 1; count < total; page++) {
          const list = await this.checked(() => this.client.listRecoveryFiles(spaceId, parentId, page), lease)
          total = list.total
          const entries = [...list.folders, ...list.files]
          if (!entries.length && count < total) throw new Error('云端目录分页不完整')
          for (const entry of entries) {
            if (seen.has(entry.id) || entry.space_id !== spaceId || entry.parent_id !== parentId)
              throw new Error('云端目录身份或分页已变化')
            seen.add(entry.id)
            result.push(entry)
            if (entry.is_dir) await visit(entry.id)
          }
          count += entries.length
        }
      }
      await visit(null)
      return result
    }
    const recovery = new CloudKnowledgeRecovery({
      load: () => orgStateStore.getCloudRecovery(key),
      save: (state) => {
        if (state.deleteLocal && !state.localCopies) {
          state.localCopies = Object.entries(orgStateStore.getShareAssociations())
            .filter(([localKey, value]) => value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease))
            .map(([localKey]) => String(JSON.parse(localKey)[3]))
        }
        if (state.mode === 'delete-only' && state.phase === 'delete-unknown' && !state.cleanupScope) {
          active()
          const associationKeys = Object.entries(orgStateStore.getShareAssociations())
            .filter(([localKey, value]) => value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease))
            .map(([localKey]) => localKey)
          state.cleanupScope = {
            associationKeys,
            cloudGroupId: orgStateStore.getOwnedSpaceGroups(lease.issuerId, lease.userId)[spaceId] ?? null,
            localGroups: Object.fromEntries(
              (state.localCopies ?? []).map((id) => [
                id,
                ks
                  .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [id] } })
                  .items.find((base) => base.id === id)?.groupId ?? null
              ])
            ),
            ...captureKnowledgeSourceBindings(encodeOrgId(spaceId))
          }
        }
        orgStateStore.setCloudRecovery(key, state)
      },
      active,
      scan,
      localCopies: () =>
        Object.entries(orgStateStore.getShareAssociations())
          .filter(([localKey, value]) => value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease))
          .map(([localKey]) => String(JSON.parse(localKey)[3]))
          .filter((localBaseId) => localBaseId !== encodeOrgId(spaceId)),
      createBase: async () => {
        const catalog = await this.checked(() => this.client.getCatalog(), lease)
        const space = catalog.owned.find((entry) => entry.id === spaceId)
        if (!space) throw new Error('云端空间不可用')
        const base = await ks.createBase({ name: space.name, embeddingModelId: null, dimensions: null })
        return base.id
      },
      hasBase: async (localBaseId) =>
        ks
          .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
          .items.some((base) => base.id === localBaseId),
      // restore: async (file, localBaseId, parentItemId) => {
      restore: async (file, localBaseId, parentItemId, expectHash) => {
        if (file.is_dir) {
          const item = knowledgeItemService.createActive(localBaseId, {
            type: 'directory',
            groupId: parentItemId,
            data: { source: file.name }
          })
          knowledgeItemService.updateStatus(item.id, 'completed')
          return item.id
        }
        let source: string | undefined
        // 只按当前账号的可信远端 ID 映射寻找副本；首传与后续同步均需校验实际字节。
        const mappings = Object.entries(orgStateStore.getShareAssociations())
          .filter(([localKey, value]) => value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease))
          .flatMap(([localKey, value]) => [
            ...(value.manifest?.entries ?? []),
            ...(orgStateStore.getFirstShareUpload(localKey)?.files ?? [])
          ])
        const mapped = mappings.find(
          (entry) => entry.fileId === file.id && entry.hash && (!file.file_hash || entry.hash === file.file_hash)
        )
        if (mapped) {
          try {
            const candidate = ks.getFilePath(mapped.itemId)
            const hash = createHash('sha256')
            for await (const bytes of createReadStream(candidate)) hash.update(bytes)
            // 无远端哈希时，可信 fileId + 上传时固化的指纹仍可证明本机字节未变。
            // if (hash.digest('hex') === mapped.hash) source = candidate
            if (hash.digest('hex') === mapped.hash) {
              source = candidate
            }
          } catch {
            /* 本机副本失效时继续下载可信原件。 */
          }
        }
        if (source) expectHash(mapped!.hash)
        if (!source && !file.has_original_file) return null
        const temp = source ? undefined : await mkdtemp(application.getPath('sys.temp', 'knowledge-recovery-'))
        try {
          if (!source) {
            const recoveredFileName = sanitizeFilename(file.name)
            if (!recoveredFileName) throw new Error('云端原文件名无效')
            // 下载目录本身已随机隔离，保留原名供知识库导入生成正确的 relativePath。
            const downloadedPath = join(temp!, recoveredFileName)
            source = downloadedPath
            await this.checked(() => this.client.downloadOriginal(file.id, source!), lease)
            /* 原下载校验仅在远端带hash时执行。
            if (file.file_hash) {
              const hash = createHash('sha256')
              for await (const bytes of createReadStream(source)) hash.update(bytes)
              if (hash.digest('hex') !== file.file_hash) throw new Error('下载原件校验失败')
            }
            */
            const hash = createHash('sha256')
            for await (const bytes of createReadStream(source)) hash.update(bytes)
            const downloadedHash = hash.digest('hex')
            if (file.file_hash && downloadedHash !== file.file_hash) throw new Error('下载原件校验失败')
            expectHash(file.file_hash || downloadedHash)
          }
          const before = new Set(knowledgeItemService.getItemsByBaseId(localBaseId).map((item) => item.id))
          await ks.addItems(localBaseId, [
            {
              type: 'file',
              groupId: parentItemId,
              data: { source: file.name, path: AbsoluteFilePathSchema.parse(source) }
            }
          ])
          active()
          const added = knowledgeItemService.getItemsByBaseId(localBaseId).filter((item) => !before.has(item.id))
          if (added.length !== 1) throw new Error('本地导入结果身份未确认')
          return added[0].id
        } finally {
          if (temp) await rm(temp, { recursive: true, force: true })
        }
      },
      fingerprint: async (itemId) => {
        if (knowledgeItemService.getById(itemId).type !== 'file') return null
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(ks.getFilePath(itemId))) hash.update(bytes)
        active()
        return hash.digest('hex')
      },
      hasRestoredItem: async (localBaseId, itemId) =>
        knowledgeItemService.getItemsByBaseId(localBaseId).some((item) => item.id === itemId),
      assertReady: async (localBaseId, itemIds) => {
        for (const itemId of itemIds) {
          const item = knowledgeItemService.getById(itemId)
          if (item.baseId !== localBaseId || item.status !== 'completed')
            throw new Error('恢复资料尚未解析完成，请稍后重试预检')
          if (item.type === 'file' && !(await stat(ks.getFilePath(itemId))).isFile())
            throw new Error('恢复原件不是可读文件')
        }
      },
      checkSpace: async () => {
        const catalog = await this.checked(() => this.client.getCatalog(), lease)
        return catalog.owned.some((entry) => entry.id === spaceId)
      },
      // deleteSpace: () => this.client.deleteShareSpace(spaceId),
      deleteSpace: () => {
        active()
        return this.client.deleteShareSpace(spaceId)
      },
      deleteLocalBase: async (localBaseId) => {
        active()
        const exists = ks
          .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
          .items.some((base) => base.id === localBaseId)
        if (exists) await ks.deleteBase(localBaseId)
      },
      finish: async (localBaseId, preserveBaseId) => {
        active()
        // replaceKnowledgeSourceBindings(encodeOrgId(spaceId), localBaseId)
        if (orgStateStore.getCloudRecovery(key)?.mode === 'delete-only') {
          removeKnowledgeSourceBindings(encodeOrgId(spaceId))
          orgStateStore.moveOwnedSpace(lease.issuerId, lease.userId, spaceId, null)
        } else replaceKnowledgeSourceBindings(encodeOrgId(spaceId), preserveBaseId ?? localBaseId)
        for (const [localKey, value] of Object.entries(orgStateStore.getShareAssociations())) {
          if (value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease)) this.clearLocalShare(localKey)
        }
      }
    })
    return { recovery, key, spaceId }
  }

  private async runRecovery<T>(
    baseId: string,
    lease: Lease,
    action: (context: ReturnType<OrgKnowledgeService['recoveryContext']>) => Promise<T>
  ): Promise<T> {
    const remoteId = parseOrgId(baseId)
    const associationKey = remoteId
      ? JSON.stringify([lease.issuerId, lease.userId, 'cloud', remoteId])
      : this.syncKey(baseId, lease)
    const spaceId = remoteId ?? orgStateStore.getShareAssociation(associationKey)?.shareId
    const keys = new Set([
      associationKey,
      ...Object.entries(orgStateStore.getShareAssociations())
        .filter(([key, value]) => value.shareId === spaceId && this.matchesSyncIdentity(key, lease))
        .map(([key]) => key)
    ])
    const recoveryKey = JSON.stringify([lease.issuerId, lease.userId, 'recovery', spaceId])
    keys.add(recoveryKey)
    if ([...keys].some((key) => this.unsharing.has(key)))
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '该知识库正在取消分享，请稍后再试')
    if ([...keys].some((key) => this.syncing.has(key) || this.firstShareActive?.key === key))
      throw new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在上传或同步，请完成后再取消分享')
    for (const key of keys) this.unsharing.add(key)
    try {
      return await this.shareMutex.runExclusive(recoveryKey, () => action(this.recoveryContext(baseId, lease)))
    } finally {
      for (const key of keys) this.unsharing.delete(key)
    }
  }

  async pendingCleanup(): Promise<Array<{ baseId: string; localBaseId: string }>> {
    const lease = this.acquireLease()
    return Object.entries(orgStateStore.getCloudRecoveries())
      .filter(
        ([key, state]) =>
          this.matchesSyncIdentity(key, lease) &&
          state.deleteLocal &&
          (state.phase === 'deleted' || state.phase === 'local-cleanup')
      )
      .map(([, state]) => ({ baseId: encodeOrgId(state.spaceId), localBaseId: state.localBaseId }))
  }

  async cleanupLocal({
    baseId,
    localBaseId
  }: {
    baseId: string
    localBaseId: string
  }): Promise<{ ok: boolean; localBaseId: string }> {
    const lease = this.acquireLease()
    return this.runRecovery(baseId, lease, async ({ recovery, key }) => {
      const state = orgStateStore.getCloudRecovery(key)
      // if (!state || state.localBaseId !== localBaseId || !state.deleteLocal) {
      if (
        !state ||
        state.localBaseId !== localBaseId ||
        !state.deleteLocal ||
        !['deleted', 'local-cleanup', 'completed'].includes(state.phase)
      ) {
        throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地清理记录不匹配')
      }
      // const result = await recovery.cancel(false, false)
      const result = await recovery.remove(state.spaceId, [], false)
      return { ok: true, localBaseId: result }
    })
  }

  async localGroups(): Promise<Record<string, string>> {
    const lease = this.acquireLease()
    return orgStateStore.getOwnedSpaceGroups(lease.issuerId, lease.userId)
  }

  async moveLocalGroup(baseId: string, groupId: string | null): Promise<void> {
    const lease = this.acquireLease()
    const spaceId = parseOrgId(baseId)
    if (!spaceId) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '云端空间身份无效')
    orgStateStore.moveOwnedSpace(lease.issuerId, lease.userId, spaceId, groupId)
  }

  async removeLocalGroup(groupId: string): Promise<void> {
    const lease = this.acquireLease()
    orgStateStore.removeOwnedSpaceGroup(lease.issuerId, lease.userId, groupId)
  }

  async unsharePreview({ baseId }: { baseId: string }) {
    const lease = this.acquireLease()
    return this.runRecovery(baseId, lease, async ({ recovery, key, spaceId }) => {
      const saved = orgStateStore.getCloudRecovery(key)
      if (saved?.phase !== 'deleted' && saved?.phase !== 'local-cleanup' && saved?.phase !== 'completed')
        await this.assertRealOwner(spaceId, lease)
      const state = await recovery.prepare(spaceId)
      return {
        localBaseId: state.localBaseId,
        phase: state.phase,
        restored: Object.keys(state.restored).length,
        missing: state.missing
      }
    })
  }

  async unshare({
    baseId,
    confirmMissing = false,
    confirmDevicesStopped = false,
    deleteLocal = false
  }: {
    baseId: string
    confirmMissing?: boolean
    confirmDevicesStopped?: boolean
    deleteLocal?: boolean
  }): Promise<{ ok: boolean; localBaseId: string }> {
    const lease = this.acquireLease()
    return this.runRecovery(baseId, lease, async ({ recovery, key, spaceId }) => {
      const saved = orgStateStore.getCloudRecovery(key)
      if (saved?.phase !== 'deleted' && saved?.phase !== 'local-cleanup' && saved?.phase !== 'completed')
        await this.assertRealOwner(spaceId, lease)
      // const localBaseId = await recovery.cancel(confirmMissing, confirmDevicesStopped, deleteLocal)
      const copies = Object.entries(orgStateStore.getShareAssociations())
        .filter(([localKey, value]) => value.shareId === spaceId && this.matchesSyncIdentity(localKey, lease))
        .map(([localKey]) => String(JSON.parse(localKey)[3]))
      const localBaseId =
        deleteLocal || saved?.deleteLocal
          ? await recovery.remove(spaceId, copies, confirmDevicesStopped)
          : await recovery.cancel(confirmMissing, confirmDevicesStopped)
      return { ok: true, localBaseId }
    })
  }

  private matchesSyncIdentity(key: string, lease: Lease): boolean {
    try {
      const parts = JSON.parse(key)
      return parts[0] === lease.issuerId && parts[1] === lease.userId
    } catch {
      return false
    }
  }

  private async assertRealOwner(shareId: string, lease: Lease): Promise<void> {
    const catalog = await this.checked(() => this.client.getCatalog(), lease)
    const owned = catalog.owned.find((space) => space.id === shareId)
    // 原 owner 字段校验保留：catalog.owned 已是服务端按当前账号归属返回的权威分类。
    // if (
    //   !owned ||
    //   !(owned.my_role === 'owner' || (owned.owner_id !== undefined && String(owned.owner_id) === lease.userId))
    // ) {
    if (!owned) {
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '仅允许操作本人拥有的关联空间')
    }
  }

  private clearLocalShare(key: string): void {
    // MEA:enterprise-knowledge-page 清除首传 state 很重要，否则下次 share 复用旧 space。
    orgStateStore.clearShare(key)
    this.firstShareProgress.delete(key)
    for (const [planId, plan] of this.syncPlans) if (plan.key === key) this.syncPlans.delete(planId)
    const timer = this.autoSyncTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.autoSyncTimers.delete(key)
    }
  }

  // MEA:enterprise-knowledge-page 首次失败补偿独立于恢复下载，unknown DELETE 永不自动重放。
  private async rollbackFirstShare(key: string, localBaseId: string, lease: Lease): Promise<void> {
    const saved = orgStateStore.getFirstShareUpload(key)
    if (!saved || saved.purpose === 'append' || orgStateStore.getShareAssociation(key)?.completion === 'completed')
      return
    saved.cleanup ??= { phase: 'pending', error: null }
    orgStateStore.setFirstShareUpload(key, saved)
    if (saved.cleanup.phase === 'intent' || saved.cleanup.phase === 'unknown') return
    if (!saved.taskId || saved.createdByTask !== saved.taskId || !saved.shareId) {
      saved.cleanup = { phase: 'unknown', error: '创建结果或任务归属未知，请联系管理员核查' }
      orgStateStore.setFirstShareUpload(key, saved)
      return
    }
    const finish = () => {
      replaceKnowledgeSourceBindings(encodeOrgId(saved.shareId!), localBaseId)
      orgStateStore.moveOwnedSpace(lease.issuerId, lease.userId, saved.shareId!, null)
      this.clearLocalShare(key)
    }
    if (saved.cleanup.phase === 'deleted') {
      try {
        this.assertLease(lease)
        finish()
      } catch {
        /* 原账号重登后完成本地清理。 */
      }
      return
    }
    try {
      this.assertLease(lease)
      await this.assertRealOwner(saved.shareId, lease)
      this.assertLease(lease)
      saved.cleanup = { phase: 'intent', error: null }
      orgStateStore.setFirstShareUpload(key, saved)
      // 不用 checked 包裹成功响应：切号后仍须先在原 key 记录删除结果。
      await this.client.deleteShareSpace(saved.shareId)
      saved.cleanup = { phase: 'deleted', error: null }
      orgStateStore.setFirstShareUpload(key, saved)
      this.assertLease(lease)
      finish()
    } catch (error) {
      if (saved.cleanup.phase !== 'deleted') {
        saved.cleanup = {
          phase: saved.cleanup.phase === 'intent' ? 'unknown' : 'pending',
          error: error instanceof Error ? error.message : String(error)
        }
        orgStateStore.setFirstShareUpload(key, saved)
      }
    }
  }

  // MEA:enterprise-knowledge-page 首传选项随计划固化，核对续作沿用已保存模式。
  share(localBaseId: string, verifyOnly = false, uploadOriginal = true): Promise<OrgKnowledgeShareResult> {
    const lease = this.acquireLease()
    const key = this.syncKey(localBaseId, lease)
    // MEA:enterprise-knowledge-page 取消分享期间拒绝新建上传，避免 DELETE 与上传竞争同一 space。
    if (this.unsharing.has(key)) {
      return Promise.reject(new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, '正在取消分享，请稍后再试'))
    }
    // MEA:enterprise-knowledge-page 在第一个await之前占用，异库拒绝且同库复用。
    if (this.firstShareActive) {
      if (this.firstShareActive.key === key) return this.firstShareActive.promise
      return Promise.reject(
        new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, `「${this.firstShareActive.name}」正在上传云端，请完成后再试`)
      )
    }
    const existing = orgStateStore.getShareAssociation(key)
    const residual = orgStateStore.getFirstShareUpload(key)
    // 首次分享的服务端文件接口要求必须包含原文件；仅分块模式只适用于已确认的云端库追加。
    const canSkipOriginal = existing?.completion === 'completed' || residual?.purpose === 'append'
    const effectiveUploadOriginal = canSkipOriginal ? uploadOriginal : true
    if (residual && !existing && !residual.cleanup) {
      residual.cleanup = { phase: 'pending', error: '首次分享任务已中断' }
      orgStateStore.setFirstShareUpload(key, residual)
    }
    if (residual?.cleanup && existing?.completion !== 'completed') {
      return this.shareMutex.runExclusive(key, async () => {
        await this.rollbackFirstShare(key, localBaseId, lease)
        throw new OrgKnowledgeError(E.ORGKB_SHARE_INCOMPLETE, '首次分享已中断，请查看清理状态后重新分享')
      })
    }
    // if (existing && (existing.completion === 'completed' || !orgStateStore.getFirstShareUpload(key))) {
    const pendingAppend =
      residual?.purpose === 'append' &&
      (residual.files.some((file) => file.phase !== 'success') ||
        (residual.folders ?? []).some((folder) => folder.phase !== 'success'))
    if (
      existing &&
      !pendingAppend &&
      (existing.completion === 'completed' || !orgStateStore.getFirstShareUpload(key))
    ) {
      // if (existing.completion === 'completed')
      //   replaceKnowledgeSourceBindings(localBaseId, encodeOrgId(existing.shareId))
      // return Promise.resolve({ ...existing, shareId: encodeOrgId(existing.shareId) })
      return this.checked(() => this.client.getSpace(existing.shareId), lease).then((space) => {
        if (space.id !== existing.shareId || typeof space.allow_local_file_upload !== 'boolean')
          throw new Error('空间源文件上传策略未确认')
        if (existing.completion === 'completed')
          replaceKnowledgeSourceBindings(localBaseId, encodeOrgId(existing.shareId))
        return { ...existing, shareId: encodeOrgId(existing.shareId) }
      })
    }
    const ks = application.get('KnowledgeService')
    const base = ks
      .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
      .items.find((item) => item.id === localBaseId)
    if (!base) return Promise.reject(new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地知识库不存在'))
    const active = () => {
      this.assertLease(lease)
      if (this.disposed) throw new Error('上传服务已停止')
    }
    // 追加沿用旧文件记录，但不能继承首次分享的回滚身份。
    // const taskId = !existing && !residual ? randomUUID() : residual?.taskId
    const taskId = existing ? undefined : (residual?.taskId ?? randomUUID())
    let createdByTask: string | undefined
    const controller = new AbortController()
    const upload = new FirstShareUpload(
      {
        get: (id) => orgStateStore.getFirstShareUpload(id),
        set: (id, state) => {
          if (taskId) {
            state.taskId = taskId
            state.purpose = 'first'
            if (createdByTask === state.shareId) state.createdByTask = taskId
          }
          state.cleanup ??= orgStateStore.getFirstShareUpload(id)?.cleanup
          orgStateStore.setFirstShareUpload(id, state)
        }
      },
      {
        // createShareSpace: (name) => this.client.createShareSpace(name),
        createShareSpace: async (name, mode) => {
          active()
          // 首传成功响应先由写前日志固化到原账号 key，再由 active 中断会话。
          const created = await this.client.createShareSpace(name, mode)
          createdByTask = created.share_id
          return created
        },
        verifyPolicy: async (shareId, mode, createdNow) => {
          const space = await this.checked(() => this.client.getSpace(shareId), lease)
          if (
            space.id !== shareId ||
            typeof space.allow_local_file_upload !== 'boolean' ||
            (mode && !space.allow_local_file_upload) ||
            (createdNow && mode !== space.allow_local_file_upload)
          )
            throw new Error('空间源文件上传策略未确认或已变化')
        },
        createShareFolder: (shareId, folder, parentId) => {
          active()
          return this.client.createShareFolder(shareId, folder, parentId)
        },
        verifyFolder: async (shareId, folderId, folder, parentId) => {
          const remote = await this.checked(() => this.client.getFile(folderId), lease)
          if (
            remote.id !== folderId ||
            remote.space_id !== shareId ||
            !remote.is_dir ||
            remote.name !== folder.fileName.trim() ||
            remote.parent_id !== parentId
          )
            throw new Error('远端目录名称或归属尚未确认')
        },
        uploadShareStream: (shareId, entry, report) => {
          active()
          return this.client.uploadShareStream(
            shareId,
            entry,
            report,
            (error) => {
              if (existing) return
              const saved = orgStateStore.getFirstShareUpload(key)
              if (saved) {
                saved.cleanup ??= { phase: 'pending', error: error instanceof Error ? error.message : String(error) }
                orgStateStore.setFirstShareUpload(key, saved)
              }
            },
            controller.signal
          )
        },
        verify: (shareId, fileId, entry) => this.verifyFirstShareFile(shareId, fileId, entry, lease)
      }
    )
    const promise = Promise.resolve()
      .then(() =>
        this.shareMutex.runExclusive(key, () =>
          upload.run(
            key,
            base.name,
            // () => this.buildFirstSharePlan(ks, localBaseId, active),
            /* 原核对按首项模式恢复，改为逐文件身份匹配。
            () =>
              this.buildFirstSharePlan(
                ks,
                localBaseId,
                active,
                verifyOnly ? (orgStateStore.getFirstShareUpload(key)?.files[0]?.uploadOriginal ?? true) : uploadOriginal
              ),
            */
            async () => {
              const savedState = orgStateStore.getFirstShareUpload(key)
              const modes = new Set(
                savedState?.files.map((file) => file.uploadOriginal).filter((mode) => typeof mode === 'boolean')
              )
              const canReuseSavedMode = existing?.completion === 'completed' || savedState?.purpose === 'append'
              let mode = canReuseSavedMode
                ? (savedState?.uploadOriginal ?? (modes.size === 1 ? [...modes][0] : undefined))
                : effectiveUploadOriginal
              if (savedState && typeof mode !== 'boolean') {
                if (!savedState.shareId || savedState.creation !== 'created')
                  throw new Error('首传模式及空间未知，禁止重建')
                const space = await this.checked(() => this.client.getSpace(savedState.shareId!), lease)
                if (space.id !== savedState.shareId || typeof space.allow_local_file_upload !== 'boolean')
                  throw new Error('空间源文件上传策略未确认')
                mode = space.allow_local_file_upload
              }
              if (savedState && typeof mode === 'boolean' && savedState.uploadOriginal === undefined) {
                savedState.uploadOriginal = mode
                orgStateStore.setFirstShareUpload(key, savedState)
              }
              const plan = await this.buildFirstSharePlan(ks, localBaseId, active, mode ?? effectiveUploadOriginal)
              /* 旧逐文件默认true恢复会导致首传模式漂移。
              if (verifyOnly) {
                const saved = orgStateStore.getFirstShareUpload(key)
                for (const entry of plan.files)
                  entry.uploadOriginal =
                    saved?.files.find((file) => file.itemId === entry.itemId)?.uploadOriginal ?? true
              }
              */
              if (savedState) {
                for (const entry of plan.files) {
                  const savedFile = savedState.files.find((file) => file.itemId === entry.itemId)
                  entry.uploadOriginal = savedFile?.uploadOriginal ?? mode
                }
              }
              return plan
            },
            (progress) => this.firstShareProgress.set(key, progress),
            active,
            verifyOnly,
            effectiveUploadOriginal
          )
        )
      )
      .then(async (result) => {
        if (result.completion !== 'completed') {
          const progress = this.firstShareProgress.get(key)
          result.error = progress?.error ?? result.files.find((file) => file.error)?.error ?? undefined
          logger.warn('knowledge first share incomplete', {
            localBaseId,
            phase: progress?.phase,
            currentFile: progress?.currentFile,
            error: result.error
          })
        }
        if (result.completion !== 'completed' && !existing) {
          await this.rollbackFirstShare(key, localBaseId, lease)
          this.assertLease(lease)
          return { ...result, shareId: '' }
        }
        active()
        const saved = orgStateStore.getFirstShareUpload(key)
        if (saved?.shareId)
          orgStateStore.setShareAssociation(key, {
            ...result,
            ...(existing?.pendingAddition ? { pendingAddition: true } : {}),
            ...(saved.purpose === 'append' && existing?.completion === 'completed' && result.completion !== 'completed'
              ? { completion: existing.completion, files: existing.files }
              : {}),
            shareId: saved.shareId,
            manifest: {
              entries: saved.files.map((file) => ({
                itemId: file.itemId,
                fileId: file.fileId,
                fileName: file.fileName,
                hash: file.hash
              })),
              operations: [],
              state: result.completion === 'completed' ? 'shared' : 'incomplete',
              lastSyncedAt: result.completion === 'completed' ? new Date().toISOString() : null
            }
          })
        if (result.completion === 'completed' && saved?.shareId)
          replaceKnowledgeSourceBindings(localBaseId, encodeOrgId(saved.shareId))
        return result
      })
      .catch(async (error) => {
        if (!existing) await this.rollbackFirstShare(key, localBaseId, lease)
        const previous = this.firstShareProgress.get(key)
        if (previous)
          this.firstShareProgress.set(key, {
            ...previous,
            phase: 'paused',
            error: error instanceof Error ? error.message : String(error)
          })
        throw error
      })
      .finally(() => {
        if (this.firstShareActive?.key === key) this.firstShareActive = undefined
      })
    this.firstShareActive = {
      key,
      name: base.name,
      promise,
      stop: () => {
        const saved = orgStateStore.getFirstShareUpload(key)
        if (!existing && saved) {
          saved.cleanup ??= { phase: 'pending', error: '上传服务已停止' }
          orgStateStore.setFirstShareUpload(key, saved)
        }
        controller.abort(new Error('上传服务已停止'))
      }
    }
    return promise
  }

  /* 原排队分享入口保留，首次上传改为上方原子占用。
  async share(localBaseId: string): Promise<OrgKnowledgeShareResult> {
    const lease = this.acquireLease()
    const key = JSON.stringify([lease.issuerId, lease.userId, lease.groupId, localBaseId])
    // return this.shareMutex.runExclusive(key, () => this.checked(() => this.createShare(localBaseId, key, lease), lease))
    const job = await this.jobs.enqueue('enterprise.knowledge-share', { localBaseId, key, lease }, { maxAttempts: 1 })
    const result = await job.finished
    this.assertLease(lease)
    if (result.status !== 'completed') {
      throw new OrgKnowledgeError(
        typeof result.metadata.errorCode === 'string' ? result.metadata.errorCode : E.ORGKB_SHARE_FAILED,
        result.error?.message ?? '共享任务已取消'
      )
    }
    return result.output as OrgKnowledgeShareResult
  }

  */

  private async buildFirstSharePlan(
    ks: ReturnType<typeof application.get<'KnowledgeService'>>,
    baseId: string,
    active: () => void,
    uploadOriginal = true
    // ): Promise<FirstShareEntry[]> {
  ): Promise<FirstSharePlan> {
    const roots = ks.listRootItems(baseId)
    const descendants = knowledgeItemService.getSubtreeItems(
      baseId,
      roots.filter((item) => item.type === 'directory').map((item) => item.id)
    )
    const items = [...new Map([...roots, ...descendants].map((item) => [item.id, item])).values()]
    const files: Array<{ item: (typeof items)[number]; path: string; size: number }> = []
    let total = 0
    for (const item of items) {
      active()
      if (!['file', 'directory'].includes(item.type) || item.status !== 'completed')
        throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, `无法完整共享: ${item.id}`)
      if (item.type !== 'file') continue
      const path = String(ks.getFilePath(item.id))
      const info = await stat(path)
      if (!info.isFile()) throw new Error('原文件不是普通文件')
      total += info.size
      // MEA:enterprise-knowledge-page 暂不设置客户端总容量上限，旧检查保留供回溯。
      // if (total >= 2 ** 31) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '知识库原文件总大小必须严格小于 2 GiB')
      // if (total >= 20 * 1024 * 1024)
      //   throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '知识库原文件总大小必须严格小于 20 MiB')
      files.push({ item, path, size: info.size })
    }
    const result: FirstShareEntry[] = []
    for (const { item, path, size } of files) {
      active()
      const chunks = await ks.listItemChunks(baseId, item.id)
      if (!chunks.length) throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, `文件 ${item.id} 没有可分享分块`)
      const data = item.data as { relativePath?: string; source?: string } | undefined
      const name = data?.relativePath || data?.source || chunks[0].metadata.source
      if (!name) throw new Error('文件缺少原始名称')
      const body = chunks.map((chunk) => ({
        chunk_id: chunk.id,
        item_id: chunk.itemId,
        document_id: item.id,
        content: chunk.content,
        metadata: {
          chunk_index: chunk.metadata.chunkIndex,
          token_count: chunk.metadata.tokenCount,
          source: chunk.metadata.source,
          item_type: chunk.metadata.itemType
        }
      }))
      const hash = createHash('sha256')
      const fingerprint = createHash('sha256')
      for await (const bytes of createReadStream(path)) {
        active()
        hash.update(bytes)
        fingerprint.update(bytes)
      }
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, child]) => [key, canonical(child)])
              )
            : value
      fingerprint
        .update('\u0000')
        .update(JSON.stringify(body.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))
      result.push({
        itemId: item.id,
        fileName: basename(name),
        parentItemId: item.groupId ?? null,
        path,
        size,
        hash: hash.digest('hex'),
        fingerprint: fingerprint.digest('hex'),
        uploadOriginal,
        chunks: body
      })
    }
    // return result
    const folders = items
      .filter((item) => item.type === 'directory')
      .map((item) => {
        const data = item.data as { relativePath?: string; source?: string }
        const name = data?.relativePath || data?.source
        if (!name) throw new Error(`目录 ${item.id} 缺少原始名称`)
        return { itemId: item.id, fileName: basename(name), parentItemId: item.groupId ?? null }
      })
    return { files: result, folders }
  }

  private async verifyFirstShareFile(
    shareId: string,
    fileId: string,
    entry: FirstShareEntry,
    lease: Lease
  ): Promise<void> {
    const file = await this.checked(() => this.client.getFile(fileId), lease)
    if (
      file.id !== fileId ||
      file.space_id !== shareId ||
      file.is_dir ||
      (entry.parentId !== undefined && (entry.parentId ? file.parent_id !== entry.parentId : file.parent_id != null)) ||
      // file.file_hash !== entry.hash ||
      (entry.uploadOriginal !== false && file.file_hash !== entry.hash) ||
      file.name !== entry.fileName
    )
      throw new Error('远端文件哈希或归属尚未确认')
    let cursor: string | null | undefined
    const seen = new Set<string>()
    do {
      const page = await this.checked(() => this.client.listItems(shareId, cursor), lease)
      const item = page.items.find(
        (candidate) =>
          candidate.base_id === shareId && (candidate.data.file_id === fileId || candidate.document_id === fileId)
      )
      if (item) {
        const visible = await this.checked(() => this.client.getItem(shareId, item.id), lease)
        const chunks = await this.checked(() => this.client.listChunks(shareId, item.id), lease)
        const chunkCursors = new Set<string>()
        let chunkCursor = chunks.next_cursor
        while (chunkCursor) {
          if (chunkCursors.has(chunkCursor)) throw new Error('远端分块分页未确认')
          chunkCursors.add(chunkCursor)
          const next = await this.checked(() => this.client.listChunks(shareId, item.id, chunkCursor), lease)
          if (next.total !== chunks.total) throw new Error('远端分块统计已变化')
          chunks.chunks.push(...next.chunks)
          chunkCursor = next.next_cursor
        }
        const local = entry.chunks as Array<{ content: string; metadata: { chunk_index: number } }>
        // MEA:enterprise-knowledge-page 每个远端分块只能匹配一次，避免重复本地分块掩盖缺失正文。
        const unmatched = [...chunks.chunks]
        const complete = local.every((chunk) => {
          const index = unmatched.findIndex(
            (remote) =>
              remote.item_id === item.id &&
              remote.content === chunk.content &&
              remote.metadata.chunk_index === chunk.metadata.chunk_index
          )
          if (index < 0) return false
          unmatched.splice(index, 1)
          return true
        })
        if (
          visible.id !== item.id ||
          (visible.data.file_id !== fileId && visible.document_id !== fileId) ||
          visible.status !== 'completed' ||
          visible.base_id !== shareId ||
          chunks.total !== local.length ||
          chunks.chunks.length !== local.length ||
          /* 原逐项存在性判断保留，改用上方一对一匹配。
          local.some(
            (chunk) =>
              !chunks.chunks.some(
                (remote) =>
                  remote.item_id === item.id &&
                  remote.content === chunk.content &&
                  remote.metadata.chunk_index === chunk.metadata.chunk_index
              )
          )
          */
          !complete
        )
          throw new Error('远端分块尚未完整确认')
        return
      }
      cursor = page.next_cursor
      if (cursor && seen.has(cursor)) throw new Error('远端目录分页未确认')
      if (cursor) seen.add(cursor)
    } while (cursor)
    throw new Error('远端文件尚未出现在知识目录')
  }

  private async createShare(
    localBaseId: string,
    key: string,
    lease: Lease,
    ctx: JobContext<ShareJobInput>
  ): Promise<OrgKnowledgeShareResult> {
    const assertActive = () => {
      ctx.signal.throwIfAborted()
      this.assertLease(lease)
    }
    assertActive()
    const existing = orgStateStore.getShareAssociation(key)
    // if (existing) return { ...existing, shareId: encodeOrgId(existing.shareId) }
    if (existing)
      return { files: existing.files, completion: existing.completion, shareId: encodeOrgId(existing.shareId) }
    const ks = application.get('KnowledgeService')
    const page = ks.listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
    const base = page.items.find((candidate) => candidate.id === localBaseId)
    if (!base) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地知识库不存在')
    const plan = await this.checked(() => this.buildSharePlan(ks, localBaseId), lease)
    if (!plan.length) throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, '该知识库没有可导出的已完成文件或分块')
    assertActive()
    // 服务端创建与本地关联落盘之间仍有崩溃窗口；OpenAPI 无创建幂等契约，无法保证重试不重复创建。
    const created = await this.checked(() => this.client.createShareSpace(base.name), lease)
    const shareId = created.share_id
    const files: OrgKnowledgeShareResult['files'] = plan.map((entry) => ({
      fileName: entry.fileName,
      status: 'unknown',
      fileId: null,
      chunkCount: null,
      error: '上传尚未确认'
    }))
    const manifest: OrgKnowledgeSyncManifest = {
      entries: plan.map((entry) => ({
        itemId: entry.itemId,
        fileId: null,
        fileName: entry.fileName,
        hash: this.entryHash(entry)
      })),
      operations: [],
      state: 'incomplete',
      lastSyncedAt: null
    }
    const persist = () => {
      const complete = files.every((file) => file.status === 'success')
      manifest.state = complete ? 'shared' : 'incomplete'
      if (complete) manifest.lastSyncedAt = new Date().toISOString()
      orgStateStore.setShareAssociation(key, {
        shareId,
        files,
        manifest,
        completion: complete ? 'completed' : 'incomplete'
      })
    }
    // 先落盘完整文件清单：中断或切号后也不能把未上传文件当成成功或自动重传。
    persist()
    for (const [index, entry] of plan.entries()) {
      // this.assertLease(lease)
      assertActive()
      const form = new FormData()
      form.append(
        'file',
        new Blob([new Uint8Array(entry.buffer)], { type: 'application/octet-stream' }),
        entry.fileName
      )
      // form.append('chunks', JSON.stringify(entry.chunks))
      form.append('chunks_file', new Blob([JSON.stringify(entry.chunks)], { type: 'application/json' }), 'chunks.json')
      try {
        const result = await this.checked(() => this.client.uploadShareFile(shareId, form), lease)
        if (result.share_id !== shareId || result.chunk_count !== entry.chunks.length) throw new Error('上传响应未确认')
        manifest.entries[index].fileId = result.file_id
        files[index] = {
          fileName: entry.fileName,
          status: 'success',
          fileId: encodeOrgId(result.file_id),
          chunkCount: result.chunk_count,
          error: null
        }
      } catch (error) {
        this.assertLease(lease)
        files[index] = {
          fileName: entry.fileName,
          status: error instanceof OrgApiHttpError ? 'failure' : 'unknown',
          fileId: null,
          chunkCount: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      persist()
      ctx.reportProgress(Math.round(((index + 1) / plan.length) * 100), { files, total: plan.length })
      assertActive()
    }
    return {
      shareId: encodeOrgId(shareId),
      files,
      completion: files.every((file) => file.status === 'success') ? 'completed' : 'incomplete'
    }
  }

  private async buildSharePlan(
    ks: {
      listRootItems(baseId: string): unknown[]
      getFilePath(itemId: string): AbsoluteFilePath
      listItemChunks(baseId: string, itemId: string): Promise<KnowledgeItemChunk[]>
    },
    localBaseId: string
  ): Promise<ShareEntry[]> {
    const items = ks.listRootItems(localBaseId) as Array<{
      id: string
      type: string
      status: string
      data?: { relativePath?: string; source?: string }
    }>
    const descendants = knowledgeItemService.getSubtreeItems(
      localBaseId,
      items.filter((item) => item.type === 'directory').map((item) => item.id)
    )
    const unsupported = [...items, ...descendants].filter(
      (item) => !['file', 'directory'].includes(item.type) || item.status !== 'completed'
    )
    if (unsupported.length) {
      throw new OrgKnowledgeError(
        E.ORGKB_SHARE_NO_CONTENT,
        `无法完整共享，包含不支持或未完成项: ${unsupported.map((item) => `${item.id} (${item.type}, ${item.status})`).join('、')}`
      )
    }
    const plan: ShareEntry[] = []
    const fileChunks = new Map<string, KnowledgeItemChunk[]>()
    for (const item of items) {
      const chunks = await ks.listItemChunks(localBaseId, item.id)
      if (item.type === 'file' && !chunks.length)
        throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, `文件 ${item.id} 没有可共享分块`)
      for (const chunk of chunks) {
        if (chunk.metadata.itemType !== 'file')
          throw new OrgKnowledgeError(
            E.ORGKB_SHARE_NO_CONTENT,
            `不支持共享项 ${chunk.itemId} (${chunk.metadata.itemType})`
          )
        const chunks = fileChunks.get(chunk.itemId) ?? []
        chunks.push(chunk)
        fileChunks.set(chunk.itemId, chunks)
      }
    }
    for (const item of descendants) {
      if (item.type === 'file' && !fileChunks.has(item.id))
        throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, `文件 ${item.id} 没有可共享分块`)
    }
    for (const [itemId, chunks] of fileChunks) {
      const filePath = ks.getFilePath(itemId)
      const buffer = await readFile(String(filePath))
      const item = [...items, ...descendants].find((candidate) => candidate.id === itemId)
      const source = item?.data
      const displayName = source?.relativePath || source?.source || chunks[0]?.metadata.source
      if (!displayName) throw new OrgKnowledgeError(E.ORGKB_SHARE_NO_CONTENT, `文件 ${itemId} 缺少原始展示名称`)
      plan.push({
        itemId,
        // fileName: basename(String(filePath)),
        fileName: basename(displayName),
        buffer,
        chunks: chunks.map((chunk) => ({
          chunk_id: chunk.id,
          item_id: chunk.itemId,
          document_id: itemId,
          content: chunk.content,
          metadata: {
            chunk_index: chunk.metadata.chunkIndex,
            token_count: chunk.metadata.tokenCount,
            source: chunk.metadata.source,
            item_type: chunk.metadata.itemType
          }
        }))
      })
    }
    return plan
  }
}

function toShare(share: Awaited<ReturnType<OrgKnowledgeClient['createShareCode']>>): OrgKnowledgeShare {
  return {
    id: encodeOrgId(share.id),
    spaceId: encodeOrgId(share.space_id),
    shareCode: share.share_code,
    shareType: share.share_type,
    hasPassword: share.has_password,
    maxViews: share.max_views,
    viewCount: share.view_count,
    expiresAt: share.expires_at,
    revokedAt: share.revoked_at,
    createdAt: share.created_at
  }
}

function toMember(m: {
  user_id: number
  username: string
  role: string
  joined_at: string
  status: string
  expires_at?: string | null
}): OrgKnowledgeMember {
  return {
    userId: m.user_id,
    username: m.username,
    role: m.role,
    joinedAt: m.joined_at,
    status: m.status,
    expiresAt: m.expires_at ?? null
  }
}

/**
 * 仍生效的成员状态（阻止重复邀请）：active/pending/invited/accepted/joined 视为已占用。
 * expired/removed/declined 等按实际契约放行（允许重新邀请）。
 */
function isLiveMemberStatus(status: string | null | undefined): boolean {
  const liveStatuses = ['active', 'pending', 'invited', 'accepted', 'joined']
  return status != null && liveStatuses.includes(status)
}
