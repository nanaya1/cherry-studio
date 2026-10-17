import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

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
import type { KnowledgeItemChunk } from '@shared/data/types/knowledge'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'
import type { AbsoluteFilePath } from '@shared/types/file'

import { FirstShareUpload, type FirstShareEntry, type FirstShareProgress } from './FirstShareUpload'
import { OrgApiHttpError } from './OrgApiClient'
import type { OrgAuthManager } from './OrgAuthManager'
import { OrgKnowledgeClient } from './OrgKnowledgeClient'
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
const AUTO_SYNC_DELAY_MS = 1_000
const KNOWLEDGE_JOB_TYPES = new Set([
  'knowledge.prepare-root',
  'knowledge.index-documents',
  'knowledge.check-file-processing-result',
  'knowledge.delete-subtree',
  'knowledge.reindex-subtree'
])

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
  private jobs!: Pick<JobManager, 'registerHandler' | 'enqueue' | 'list' | 'onJobSettled'>
  private readonly syncPlans = new Map<string, SyncPlan>()
  private readonly syncing = new Set<string>()
  private readonly autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private jobSettledSubscription?: Disposable
  private disposed = false
  private firstShareActive?: { key: string; name: string; promise: Promise<OrgKnowledgeShareResult> }
  private readonly firstShareProgress = new Map<string, FirstShareProgress>()

  initialize(jobs: Pick<JobManager, 'registerHandler' | 'enqueue' | 'list' | 'onJobSettled'>): void {
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
            return await this.executeSync(ctx.input, ctx.signal)
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
    this.jobSettledSubscription?.dispose()
    this.jobSettledSubscription = undefined
    for (const timer of this.autoSyncTimers.values()) clearTimeout(timer)
    this.autoSyncTimers.clear()
  }

  private onJobSettled(event: JobSettledEvent): void {
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
  }

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

  constructor(private readonly auth: OrgAuthManager) {
    this.client = new OrgKnowledgeClient(auth.apiClient)
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
    const toBase = (b: { id: string; name: string; description?: string | null; document_count?: number }) => ({
      id: encodeOrgId(b.id),
      name: b.name,
      description: b.description ?? null,
      documentCount: b.document_count
    })
    return {
      public: raw.public.map(toBase),
      shared: raw.shared.map(toBase),
      owned: raw.owned.map((base) => ({ ...toBase(base), localBaseId: localBaseId(base.id) }))
    }
  }

  async listItems(baseId: string, cursor?: string | null): Promise<OrgKnowledgeItemPage> {
    const rawBase = this.decodeId(baseId, 'baseId')
    const lease = this.acquireLease()
    const raw = await this.checked(() => this.client.listItems(rawBase, cursor), lease)
    const fileIds = new Map<string, string>()
    for (const item of raw.items) {
      if (item.type !== 'file' || !item.document_id || item.data.file_id) continue
      try {
        // MEA:enterprise-knowledge-page 不透明文档 ID 必须经文件接口确认，不能直接视作文件 ID。
        const fileId = await this.checked(() => this.client.resolveFileId(item.document_id!), lease)
        if (fileId) fileIds.set(item.id, fileId)
      } catch (error) {
        if (!(error instanceof OrgApiHttpError) || error.status !== 404) throw error
      }
    }
    return {
      items: raw.items.map((it) => ({
        id: encodeOrgId(it.id),
        baseId: encodeOrgId(it.base_id),
        type: it.type,
        title: it.title,
        status: it.status,
        documentId: it.document_id ? encodeOrgId(it.document_id) : null,
        fileId:
          typeof it.data.file_id === 'string' && it.data.file_id
            ? encodeOrgId(it.data.file_id)
            : fileIds.has(it.id)
              ? encodeOrgId(fileIds.get(it.id)!)
              : null,
        createdAt: it.created_at,
        updatedAt: it.updated_at
      })),
      total: raw.total,
      nextCursor: raw.next_cursor ?? null
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

  async preview(params: { fileId: string }): Promise<OrgKnowledgePreview> {
    const fileId = this.decodeId(params.fileId, 'fileId')
    const lease = this.acquireLease()
    const preview = await this.checked(() => this.client.getPreviewUrl(fileId), lease)
    const mimeType = preview.mime_type?.split(';')[0].trim().toLowerCase() ?? null
    if (
      preview.kind === 'text' ||
      (preview.kind === 'inline' && (mimeType?.startsWith('text/') || mimeType === 'application/json'))
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
      if (value.shareId !== spaceId) return false
      try {
        const [issuerId, userId] = JSON.parse(key)
        return issuerId === lease.issuerId && userId === lease.userId
      } catch {
        return false
      }
    })
    // 必须存在本账号可验证的本地关联：仅允许分享本地知识库，禁止任意 owned 远端空间再分享。
    if (associations.length === 0) {
      throw new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '仅允许分享本地已关联的知识库')
    }
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
    const raw = await this.checked(async () => {
      try {
        return await this.client.createShareCode(spaceId, params)
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
    // 仅接受本地知识库 uuid，禁止任意 orgkb 远端/公共/共享空间。
    if (isOrgId(params.baseId)) throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '邀请仅支持本地知识库')
    // 解析本地已完成的可信关联（副本已上传确认），不允许未关联或未完成即邀请。
    const lease = this.acquireLease()
    // 与共享状态使用同一身份上下文的关联键，避免误判已共享的本地库。
    // const association = orgStateStore.getShareAssociation(params.baseId)
    const association = orgStateStore.getShareAssociation(this.syncKey(params.baseId, lease))
    if (!association || association.completion !== 'completed') {
      throw new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '该本地知识库尚未完成共享关联，无法邀请')
    }
    const spaceId = association.shareId
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
    return toMember(await this.checked(() => this.client.addMember(spaceId, params.userId, params.expireDays), lease))
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
    const lease = this.acquireLease()
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
          form.append('chunks', JSON.stringify(entry!.chunks))
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

  async uploadStatus(baseId: string): Promise<FirstShareProgress | null> {
    const key = this.syncKey(baseId, this.acquireLease())
    const progress = this.firstShareProgress.get(key)
    if (progress) return { ...progress }
    const saved = orgStateStore.getFirstShareUpload(key)
    if (!saved) return null
    return {
      phase: saved.files.every((file) => file.phase === 'success') ? 'completed' : 'paused',
      totalBytes: saved.files.reduce((sum, file) => sum + file.size, 0),
      uploadedBytes: saved.files.reduce((sum, file) => sum + (file.phase === 'success' ? file.size : 0), 0),
      completedFiles: saved.files.filter((file) => file.phase === 'success').length,
      totalFiles: saved.files.length,
      currentFile: null,
      error:
        saved.files.find((file) => file.error)?.error ??
        (saved.creation !== 'created' ? '创建云端库结果未知，请联系管理员核查' : null)
    }
  }

  share(localBaseId: string, verifyOnly = false): Promise<OrgKnowledgeShareResult> {
    const lease = this.acquireLease()
    const key = this.syncKey(localBaseId, lease)
    // MEA:enterprise-knowledge-page 在第一个await之前占用，异库拒绝且同库复用。
    if (this.firstShareActive) {
      if (this.firstShareActive.key === key) return this.firstShareActive.promise
      return Promise.reject(
        new OrgKnowledgeError(E.ORGKB_SHARE_FAILED, `「${this.firstShareActive.name}」正在上传云端，请完成后再试`)
      )
    }
    const existing = orgStateStore.getShareAssociation(key)
    if (existing && (existing.completion === 'completed' || !orgStateStore.getFirstShareUpload(key)))
      return Promise.resolve({ ...existing, shareId: encodeOrgId(existing.shareId) })
    const ks = application.get('KnowledgeService')
    const base = ks
      .listBasesForDiscovery({ limit: 1, scope: { kind: 'restricted', baseIds: [localBaseId] } })
      .items.find((item) => item.id === localBaseId)
    if (!base) return Promise.reject(new OrgKnowledgeError(E.ORGKB_BAD_INPUT, '本地知识库不存在'))
    const active = () => {
      this.assertLease(lease)
      if (this.disposed) throw new Error('上传服务已停止')
    }
    const upload = new FirstShareUpload(
      {
        get: (id) => orgStateStore.getFirstShareUpload(id),
        set: (id, state) => orgStateStore.setFirstShareUpload(id, state)
      },
      {
        createShareSpace: (name) => this.client.createShareSpace(name),
        uploadShareStream: (shareId, entry, report) => this.client.uploadShareStream(shareId, entry, report),
        verify: (shareId, fileId, entry) => this.verifyFirstShareFile(shareId, fileId, entry, lease)
      }
    )
    const promise = Promise.resolve()
      .then(() =>
        this.shareMutex.runExclusive(key, () =>
          upload.run(
            key,
            base.name,
            () => this.buildFirstSharePlan(ks, localBaseId, active),
            (progress) => this.firstShareProgress.set(key, progress),
            active,
            verifyOnly
          )
        )
      )
      .then((result) => {
        active()
        const saved = orgStateStore.getFirstShareUpload(key)
        if (saved?.shareId)
          orgStateStore.setShareAssociation(key, {
            ...result,
            shareId: saved.shareId,
            manifest: {
              entries: saved.files.map((file) => ({
                itemId: file.itemId,
                fileId: file.fileId,
                fileName: file.fileName,
                hash: file.fingerprint
              })),
              operations: [],
              state: result.completion === 'completed' ? 'shared' : 'incomplete',
              lastSyncedAt: result.completion === 'completed' ? new Date().toISOString() : null
            }
          })
        return result
      })
      .catch((error) => {
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
    this.firstShareActive = { key, name: base.name, promise }
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
    active: () => void
  ): Promise<FirstShareEntry[]> {
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
        path,
        size,
        hash: hash.digest('hex'),
        fingerprint: fingerprint.digest('hex'),
        chunks: body
      })
    }
    return result
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
      file.file_hash !== entry.hash ||
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
        if (
          visible.status !== 'completed' ||
          visible.base_id !== shareId ||
          chunks.total !== local.length ||
          chunks.chunks.length !== local.length ||
          local.some(
            (chunk) =>
              !chunks.chunks.some(
                (remote) =>
                  remote.item_id === item.id &&
                  remote.content === chunk.content &&
                  remote.metadata.chunk_index === chunk.metadata.chunk_index
              )
          )
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
      form.append('chunks', JSON.stringify(entry.chunks))
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
