import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

import * as z from 'zod'

import { loggerService } from '@logger'

import { javaResponseErrorMessage } from './JavaResponseError'

const logger = loggerService.withContext('JavaKnowledgeClient')
type RequestDiagnostics = { status?: number; code?: number; requestId?: string }

function requestLog(baseUrl: string, path: string, method: string) {
  const url = new URL(path, baseUrl)
  const resources: Record<string, string> = {}
  // 仅记录资源定位字段，不记录任意查询参数、请求头或正文。
  for (const key of ['scope', 'id', 'knowledgeId', 'fileId', 'chunkId']) {
    const value = url.searchParams.get(key)
    if (value && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) resources[key] = value
  }
  const metadata = { origin: url.origin, method, path: url.pathname, ...resources }
  const diagnostics: RequestDiagnostics = {}
  const started = performance.now()
  logger.info('knowledge request started', metadata)
  return {
    diagnostics,
    finish(outcome: 'success' | 'failed', aborted: boolean) {
      const entry = {
        ...metadata,
        ...diagnostics,
        outcome,
        aborted,
        durationMs: Math.round(performance.now() - started)
      }
      if (outcome === 'success') logger.info('knowledge request completed', entry)
      else logger.warn('knowledge request completed', entry)
    }
  }
}

export type JavaKnowledgeCategory = 'PUBLIC' | 'OWNED' | 'SHARED'
export type JavaKnowledgeSpaceKind = 'local' | 'online'
export type JavaKnowledgeSearchMode = 'keyword' | 'vector' | 'hybrid'

export interface JavaKnowledgeSpace {
  id: string
  tenantId: number | null
  name: string
  description: string | null
  ownerId: number | null
  ownerName: string | null
  visibility: number | null
  category: JavaKnowledgeCategory | null
  creationOrigin: string | null
  publicRegistered: boolean | null
  accessSources: string[]
  source: string | null
  sourceKnowledgeId: string | null
  accessRule: string | null
  editable: boolean | null
  canManageMembers: boolean | null
  canManageShares: boolean | null
  canDownload: boolean | null
  spaceKind: JavaKnowledgeSpaceKind | null
  allowLocalFileUpload: boolean | null
  storageQuota: number | null
  manageable: boolean | null
  createTime: string | null
  updateTime: string | null
}

export interface JavaKnowledgeFile {
  knowledgeId: string
  fileId: string
  parentId: string | null
  name: string
  directory: boolean
  fileCategory: string | null
  mimeType: string | null
  hasOriginalFile: boolean | null
  fileSize: number | null
  fileHash: string | null
  parseStatus: string | null
  errorMessage: string | null
  parsedAt: string | null
  createTime: string | null
  updateTime: string | null
}

export interface JavaKnowledgeChunk {
  knowledgeId: string
  fileId: string
  chunkId: string
  chunkIndex: number | null
  content: string
  tokenCount: number | null
  chunkType: string | null
}

export interface JavaKnowledgeContent {
  knowledgeId: string
  fileId: string
  title: string | null
  content: string
  totalChars: number | null
  truncated: boolean | null
}

export interface JavaKnowledgeSearchHit {
  knowledgeId: string
  fileId: string | null
  chunkId: string | null
  title: string | null
  content: string | null
  score: number | null
}

export interface JavaKnowledgeSearchResult {
  hits: JavaKnowledgeSearchHit[]
  modeFallback: string | null
}

export interface JavaKnowledgeShare {
  knowledgeId: string
  receivable: boolean
  // 写返回补充字段（列表旧测试仅依赖 knowledgeId/receivable，保持可选）
  shareId?: string | null
  shareCode?: string | null
  hasPassword?: boolean | null
  maxViews?: number | null
  viewCount?: number | null
  expiresAt?: string | null
  revokedAt?: string | null
  createTime?: string | null
}

export interface JavaKnowledgeMember {
  userId: number
  role: string
  status: string | null
  expiresAt: string | null
  activeTenantMember: boolean
  invitationId?: string | null
  showName?: string | null
}

/** /member/options 返回的企业成员可选项（原生 TenantMemberOptionVO）。 */
export interface JavaKnowledgeMemberOption {
  userId: number
  username: string | null
  showName: string | null
}

/** /invitation/page 返回的本人的待处理邀请（原生 KnowledgeInvitationVO）。 */
export interface JavaKnowledgeInvitation {
  invitationId: string
  knowledgeId: string
  name: string | null
  inviterId: number | null
  inviterName: string | null
  expiresAt: string | null
}

/** /operation/page 返回的可核对操作（原生 KnowledgeOperationVO）。 */
export interface JavaKnowledgeOperation {
  id: number
  knowledgeId: string | null
  creationOrigin: string | null
  publicState: string | null
  operationState: string | null
}

export interface JavaKnowledgePage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface JavaKnowledgeStream {
  bytes: Buffer
  contentType: string
}

export interface JavaKnowledgeClientOptions {
  baseUrl: string
  getAccessToken: () => Promise<string>
  onSessionExpired: () => void | Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface JavaKnowledgeCatalogOptions {
  category?: JavaKnowledgeCategory
  keyword?: string
  pageSize?: number
}

export interface JavaKnowledgeListFilesOptions {
  page?: number
  pageSize?: number
  keyword?: string
  parentId?: string
  rootOnly?: boolean
  parseStatus?: string
}

export interface JavaKnowledgeSearchOptions {
  knowledgeIds: string[]
  query: string
  topK?: number
  rerank?: boolean
  mode?: JavaKnowledgeSearchMode
}

export class JavaKnowledgeError extends Error {
  constructor(
    public readonly code: number,
    msg?: unknown,
    requestId?: unknown
  ) {
    super(javaResponseErrorMessage(code, msg, requestId, '企业资源'))
    this.name = 'JavaKnowledgeError'
  }
}

/**
 * 流式上传无进展超时：仅在整段传输无任何字节推进/响应时中止，
 * 不套 30s 总超时（大文件可超过 5 分钟）。沿用 requestFileMultipart 语义。
 */
const NO_PROGRESS_TIMEOUT_MS = 5 * 60_000

const KNOWLEDGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX32 = /^[0-9a-f]{32}$/

const uuid = z.string().regex(KNOWLEDGE_UUID, '知识库ID格式无效')
const hex32 = z.string().regex(HEX32, '文件或分块ID格式无效')

const knowledgeVOSchema = z
  .object({
    id: uuid,
    tenantId: z.union([z.number().int(), z.null()]).optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    ownerId: z.union([z.number().int(), z.null()]).optional(),
    ownerName: z.string().nullable().optional(),
    visibility: z.union([z.number().int(), z.null()]).optional(),
    category: z.enum(['PUBLIC', 'OWNED', 'SHARED']).nullable().optional(),
    creationOrigin: z.enum(['ADMIN_CREATED', 'LOCAL_SHARE', 'UNKNOWN', 'PUBLISHED']).nullable().optional(),
    publicRegistered: z.boolean().nullable().optional(),
    accessSources: z.array(z.string()).optional(),
    source: z.string().nullable().optional(),
    sourceKnowledgeId: z.string().nullable().optional(),
    accessRule: z.string().nullable().optional(),
    editable: z.boolean().nullable().optional(),
    canManageMembers: z.boolean().nullable().optional(),
    canManageShares: z.boolean().nullable().optional(),
    canDownload: z.boolean().nullable().optional(),
    spaceKind: z.enum(['local', 'online']).nullable().optional(),
    allowLocalFileUpload: z.boolean().nullable().optional(),
    storageQuota: z.union([z.number().int(), z.null()]).optional(),
    manageable: z.boolean().nullable().optional(),
    createTime: z.string().nullable().optional(),
    updateTime: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeFileVOSchema = z
  .object({
    knowledgeId: uuid,
    fileId: hex32,
    parentId: z.string().nullable().optional(),
    name: z.string(),
    directory: z.boolean(),
    fileCategory: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    hasOriginalFile: z.boolean().nullable().optional(),
    fileSize: z.union([z.number().int(), z.null()]).optional(),
    fileHash: z.string().nullable().optional(),
    parseStatus: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    parsedAt: z.string().nullable().optional(),
    createTime: z.string().nullable().optional(),
    updateTime: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeChunkVOSchema = z
  .object({
    knowledgeId: uuid,
    fileId: hex32,
    chunkId: hex32,
    chunkIndex: z.number().int().nullable().optional(),
    content: z.string(),
    tokenCount: z.number().int().nullable().optional(),
    chunkType: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeContentVOSchema = z
  .object({
    knowledgeId: uuid,
    fileId: hex32,
    title: z.string().nullable().optional(),
    content: z.string(),
    totalChars: z.union([z.number().int(), z.null()]).optional(),
    truncated: z.boolean().nullable().optional()
  })
  .passthrough()

const knowledgeSearchHitVOSchema = z
  .object({
    knowledgeId: uuid,
    fileId: hex32.nullable().optional(),
    chunkId: hex32.nullable().optional(),
    title: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    score: z.number().nullable().optional()
  })
  .passthrough()

const knowledgeShareVOSchema = z
  .object({
    knowledgeId: uuid,
    receivable: z.boolean(),
    shareId: z.string().nullable().optional(),
    shareCode: z.string().nullable().optional(),
    hasPassword: z.boolean().nullable().optional(),
    maxViews: z.union([z.number().int(), z.null()]).optional(),
    viewCount: z.union([z.number().int(), z.null()]).optional(),
    expiresAt: z.string().nullable().optional(),
    revokedAt: z.string().nullable().optional(),
    createTime: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeMemberVOSchema = z
  .object({
    userId: z.number().int(),
    role: z.string(),
    status: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
    activeTenantMember: z.boolean(),
    invitationId: z.string().nullable().optional(),
    showName: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeMemberOptionVOSchema = z
  .object({
    userId: z.number().int(),
    username: z.string().nullable().optional(),
    showName: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeInvitationVOSchema = z
  .object({
    invitationId: hex32,
    knowledgeId: uuid,
    name: z.string().nullable().optional(),
    inviterId: z.union([z.number().int(), z.null()]).optional(),
    inviterName: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional()
  })
  .passthrough()

const knowledgeOperationVOSchema = z
  .object({
    id: z.number().int(),
    knowledgeId: z.string().nullable().optional(),
    creationOrigin: z.string().nullable().optional(),
    publicState: z.string().nullable().optional(),
    operationState: z.string().nullable().optional()
  })
  .passthrough()

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识库响应格式无效')
  return value as Record<string, unknown>
}

function assertAttribution(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`知识库${label}归属校验失败`)
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}无效`)
  }
  return value
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 只读知识库客户端：独立传输，不接入 OrgApiClient，不携带 Bearer 凭证。 */
export class JavaKnowledgeClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: JavaKnowledgeClientOptions) {
    this.baseUrl = new URL(options.baseUrl).origin
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  // private async unwrap(value: unknown): Promise<unknown> {
  private async unwrap(value: unknown, diagnostics?: RequestDiagnostics): Promise<unknown> {
    const envelope = object(value)
    if (diagnostics) {
      if (Number.isInteger(envelope.code)) diagnostics.code = envelope.code as number
      if (typeof envelope.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(envelope.requestId))
        diagnostics.requestId = envelope.requestId
    }
    if (envelope.code === 200) return envelope.data
    if (!Number.isInteger(envelope.code)) throw new Error('知识库响应缺少有效业务状态码')
    if (envelope.code === 10008) await this.options.onSessionExpired()
    throw new JavaKnowledgeError(envelope.code as number, envelope.msg, envelope.requestId)
  }

  private query(params: Record<string, unknown>): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      search.set(key, String(value))
    }
    const text = search.toString()
    return text ? `?${text}` : ''
  }

  /** 底层传输；beforeSend 在 accessToken 解析完成后、fetch 发起前执行，用于切号租约守卫。上传复用本方法（复用 protected 可见性）。 */
  protected async request<T>(
    path: string,
    // consume: (response: Response) => Promise<T>,
    consume: (response: Response, diagnostics: RequestDiagnostics) => Promise<T>,
    init: RequestInit = {},
    beforeSend?: () => void
  ): Promise<T> {
    const token = await this.options.getAccessToken()
    if (!token) throw new Error('未登录')
    const headers = new Headers(init.headers)
    headers.set('token', token)
    if (beforeSend) beforeSend()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000)
    const log = requestLog(this.baseUrl, path, init.method ?? 'GET')
    let outcome: 'success' | 'failed' = 'failed'
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error'
      })
      log.diagnostics.status = response.status
      if (!response.ok) {
        if (response.status === 401) await this.options.onSessionExpired()
        throw new Error(`知识库请求失败 (${response.status})`)
      }
      // return await consume(response)
      const result = await consume(response, log.diagnostics)
      outcome = 'success'
      return result
    } catch (error) {
      if (controller.signal.aborted) throw new Error('知识库请求超时，请重试')
      throw error
    } finally {
      clearTimeout(timeout)
      log.finish(outcome, controller.signal.aborted)
    }
  }

  protected json(path: string, init?: RequestInit, beforeSend?: () => void): Promise<unknown> {
    // return this.request(path, async (response) => this.unwrap(await response.json()), init, beforeSend)
    return this.request(
      path,
      async (response, diagnostics) => this.unwrap(await response.json(), diagnostics),
      init,
      beforeSend
    )
  }

  /**
   * 流式 multipart 上传传输（原件直传，不整文件缓冲）。
   * 独立 token 头、scope 由调用方拼入 path、无进展超时（不套 30s 总超时）、
   * beforeSend 租约在取 token 后发请求前生效、无重试。返回已解包的业务 data。
   * 调用方（JavaKnowledgeUpload）负责组装 multipart 字段与响应校验。
   */
  async uploadMultipart(
    path: string,
    contentType: string,
    contentLength: number,
    bodyFactory: (resetTimeout: () => void, signal: AbortSignal) => AsyncIterable<Uint8Array>,
    beforeSend?: () => void,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const token = await this.options.getAccessToken()
    signal?.throwIfAborted()
    if (!token) throw new Error('未登录')
    const headers = new Headers()
    headers.set('token', token)
    headers.set('content-type', contentType)
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      headers.set('content-length', String(contentLength))
    }
    // 租约守卫：取 token 之后、发请求之前；账号切换在此抛错即中止发送。
    if (beforeSend) beforeSend()
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abortUpload = () => controller.abort(new DOMException('上传已取消，结果需核对', 'AbortError'))
    signal?.addEventListener('abort', abortUpload, { once: true })
    const timer = setTimeout(
      () => controller.abort(new DOMException('上传无进展超时，结果需核对', 'TimeoutError')),
      NO_PROGRESS_TIMEOUT_MS
    )
    const resetTimeout = () => timer.refresh()
    const source = Readable.from(bodyFactory(resetTimeout, controller.signal), { highWaterMark: 1 })
    const destroySource = () => source.destroy(controller.signal.reason)
    controller.signal.addEventListener('abort', destroySource, { once: true })
    const init: RequestInit & { duplex: 'half' } = {
      signal: controller.signal,
      method: 'POST',
      redirect: 'error',
      duplex: 'half',
      body: Readable.toWeb(source) as ReadableStream<Uint8Array>,
      headers
    }
    const log = requestLog(this.baseUrl, path, 'POST')
    let outcome: 'success' | 'failed' = 'failed'
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init)
      log.diagnostics.status = response.status
      resetTimeout()
      if (!response.ok) {
        if (response.status === 401) await this.options.onSessionExpired()
        throw new Error(`知识库上传请求失败 (${response.status})`)
      }
      // const data = await this.unwrap(await response.json())
      const data = await this.unwrap(await response.json(), log.diagnostics)
      controller.signal.throwIfAborted()
      outcome = 'success'
      return data
    } catch (error) {
      // if (controller.signal.aborted) throw new Error('上传无进展超时，结果需核对')
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      clearTimeout(timer)
      log.finish(outcome, controller.signal.aborted)
      signal?.removeEventListener('abort', abortUpload)
      controller.abort()
      controller.signal.removeEventListener('abort', destroySource)
      source.destroy()
      await finished(source).catch(() => {})
    }
  }

  // private async consumeStream(response: Response): Promise<JavaKnowledgeStream> {
  private async consumeStream(response: Response, diagnostics?: RequestDiagnostics): Promise<JavaKnowledgeStream> {
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const bytes = Buffer.from(await response.arrayBuffer())
    // Java 文件流带 Content-Disposition；JSON 原件也可能包含 code 字段。
    const disposition = response.headers.get('content-disposition') ?? ''
    if (
      !/^(inline|attachment)(?:;|$)/i.test(disposition.trim()) &&
      (contentType === 'application/json' ||
        contentType.endsWith('+json') ||
        bytes.subarray(0, 64).toString('utf8').trimStart().startsWith('{'))
    ) {
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        return { bytes, contentType }
      }
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Number.isInteger((value as Record<string, unknown>).code)
      ) {
        // await this.unwrap(value)
        await this.unwrap(value, diagnostics)
        throw new Error('知识库文件接口未返回文件内容')
      }
    }
    return { bytes, contentType }
  }

  private parsePage(data: unknown, label: string) {
    const page = object(data)
    if (!Array.isArray(page.items) || typeof page.total !== 'number') {
      throw new Error(`${label}分页响应无效`)
    }
    return { items: page.items as unknown[], total: safeInteger(page.total, `${label}总数`) }
  }

  /** 取当前客户端三分类下的全部知识库（服务端 category 分桶，跨页至总数满足）。 */
  async getCatalog(options: JavaKnowledgeCatalogOptions = {}): Promise<JavaKnowledgeSpace[]> {
    if (options.category !== undefined && !['PUBLIC', 'OWNED', 'SHARED'].includes(options.category)) {
      throw new Error('知识库分类不合法')
    }
    const pageSize = options.pageSize ?? 100
    const spaces: JavaKnowledgeSpace[] = []
    for (let page = 1; ; page += 1) {
      const data = this.parsePage(
        await this.json(
          `/api/v1/knowledge/page${this.query({
            scope: 'client',
            page,
            pageSize,
            category: options.category,
            keyword: options.keyword
          })}`
        ),
        '知识库目录'
      )
      for (const entry of data.items) {
        spaces.push(knowledgeVOSchema.parse(object(entry)) as JavaKnowledgeSpace)
      }
      if (page * pageSize >= data.total) break
      if (data.items.length === 0) throw new Error('知识库分页不完整，请刷新后重试')
    }
    return spaces
  }

  /** 单个知识库详情，校验 ID 归属。 */
  async getSpace(id: string): Promise<JavaKnowledgeSpace> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    const space = knowledgeVOSchema.parse(
      object(await this.json(`/api/v1/knowledge/detail${this.query({ scope: 'client', id })}`))
    ) as JavaKnowledgeSpace
    assertAttribution(space.id, id, '详情')
    return space
  }

  /** 单页文件与目录列表，校验每条记录的知识库归属。 */
  async listFiles(
    knowledgeId: string,
    options: JavaKnowledgeListFilesOptions = {}
  ): Promise<JavaKnowledgePage<JavaKnowledgeFile>> {
    if (!KNOWLEDGE_UUID.test(knowledgeId)) throw new Error('知识库ID格式无效')
    const page = options.page ?? 1
    const pageSize = options.pageSize ?? 100
    const data = this.parsePage(
      await this.json(
        `/api/v1/knowledge/file/page${this.query({
          scope: 'client',
          knowledgeId,
          page,
          pageSize,
          keyword: options.keyword,
          parentId: options.parentId,
          rootOnly: options.rootOnly,
          parseStatus: options.parseStatus
        })}`
      ),
      '知识库文件'
    )
    const items = data.items.map((entry) => {
      const file = knowledgeFileVOSchema.parse(object(entry)) as JavaKnowledgeFile
      assertAttribution(file.knowledgeId, knowledgeId, '文件')
      return file
    })
    return { items, total: data.total, page, pageSize }
  }

  /** 单个文件或目录详情，校验知识库与文件双重归属。 */
  async getFile(id: string, fileId: string): Promise<JavaKnowledgeFile> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    const file = knowledgeFileVOSchema.parse(
      object(await this.json(`/api/v1/knowledge/file/detail${this.query({ scope: 'client', id, fileId })}`))
    ) as JavaKnowledgeFile
    assertAttribution(file.knowledgeId, id, '文件')
    assertAttribution(file.fileId, fileId, '文件')
    return file
  }

  /** 已就绪文件分块分页，校验知识库与文件双重归属。 */
  async listChunks(knowledgeId: string, fileId: string, page = 1): Promise<JavaKnowledgePage<JavaKnowledgeChunk>> {
    if (!KNOWLEDGE_UUID.test(knowledgeId)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    const pageSize = 100
    const data = this.parsePage(
      await this.json(
        `/api/v1/knowledge/file/chunks${this.query({ scope: 'client', knowledgeId, fileId, page, pageSize })}`
      ),
      '知识库分块'
    )
    const items = data.items.map((entry) => {
      const chunk = knowledgeChunkVOSchema.parse(object(entry)) as JavaKnowledgeChunk
      assertAttribution(chunk.knowledgeId, knowledgeId, '分块')
      assertAttribution(chunk.fileId, fileId, '分块')
      return chunk
    })
    return { items, total: data.total, page, pageSize }
  }

  /** 已就绪文件正文或分块邻文，校验知识库与文件归属。 */
  async read(id: string, fileId: string, chunkId?: string): Promise<JavaKnowledgeContent> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    if (chunkId !== undefined && !HEX32.test(chunkId)) throw new Error('分块ID格式无效')
    const content = knowledgeContentVOSchema.parse(
      object(await this.json(`/api/v1/knowledge/file/content${this.query({ scope: 'client', id, fileId, chunkId })}`))
    ) as JavaKnowledgeContent
    assertAttribution(content.knowledgeId, id, '正文')
    assertAttribution(content.fileId, fileId, '正文')
    return content
  }

  /** 在当前企业已授权范围内检索，必须显式指定 knowledgeIds，绝不隐式全库。 */
  async search(options: JavaKnowledgeSearchOptions): Promise<JavaKnowledgeSearchResult> {
    const knowledgeIds = options.knowledgeIds
    if (!Array.isArray(knowledgeIds) || knowledgeIds.length === 0) {
      throw new Error('检索必须显式指定知识库范围')
    }
    for (const id of knowledgeIds) {
      if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    }
    const query = options.query?.trim()
    if (!query) throw new Error('检索文本不能为空')
    const body: Record<string, unknown> = { scope: 'client', query, knowledgeIds }
    if (options.topK != null) body.topK = options.topK
    if (options.rerank != null) body.rerank = options.rerank
    if (options.mode != null) body.mode = options.mode
    const data = object(
      await this.json('/api/v1/knowledge/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
    if (!Array.isArray(data.chunks)) throw new Error('检索响应无效')
    const hits = (data.chunks as unknown[]).map((entry) => {
      const hit = knowledgeSearchHitVOSchema.parse(object(entry)) as JavaKnowledgeSearchHit
      if (!knowledgeIds.includes(hit.knowledgeId)) throw new Error('检索命中超出显式知识库范围')
      return hit
    })
    return { hits, modeFallback: textOrNull(data.modeFallback) }
  }

  /** 校验归属后预览原文件，返回字节与内容类型（不落盘）。 */
  async preview(id: string, fileId: string): Promise<JavaKnowledgeStream> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    // return this.request(`/api/v1/knowledge/file/preview${this.query({ scope: 'client', id, fileId })}`, (response) => this.consumeStream(response))
    return this.request(
      `/api/v1/knowledge/file/preview${this.query({ scope: 'client', id, fileId })}`,
      (response, diagnostics) => this.consumeStream(response, diagnostics)
    )
  }

  /** 校验归属后下载原文件，返回字节与内容类型（不落盘）。 */
  async download(id: string, fileId: string): Promise<JavaKnowledgeStream> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    // return this.request(`/api/v1/knowledge/file/download${this.query({ scope: 'client', id, fileId })}`, (response) => this.consumeStream(response))
    return this.request(
      `/api/v1/knowledge/file/download${this.query({ scope: 'client', id, fileId })}`,
      (response, diagnostics) => this.consumeStream(response, diagnostics)
    )
  }

  /** 知识库分享列表（取 receivable 标记用于跨端证据），跨页至总数满足。 */
  async listShares(knowledgeId: string): Promise<JavaKnowledgeShare[]> {
    if (!KNOWLEDGE_UUID.test(knowledgeId)) throw new Error('知识库ID格式无效')
    const shares: JavaKnowledgeShare[] = []
    for (let page = 1; ; page += 1) {
      const data = this.parsePage(
        await this.json(
          `/api/v1/knowledge/share/page${this.query({ scope: 'client', knowledgeId, page, pageSize: 100 })}`
        ),
        '知识库分享'
      )
      for (const entry of data.items) {
        const share = knowledgeShareVOSchema.parse(object(entry)) as JavaKnowledgeShare
        assertAttribution(share.knowledgeId, knowledgeId, '分享')
        shares.push(share)
      }
      if (page * 100 >= data.total) break
      if (data.items.length === 0) throw new Error('知识库分享分页不完整，请刷新后重试')
    }
    return shares
  }

  /** 知识库成员列表（取 viewer/状态用于跨端证据），跨页至总数满足。 */
  async listMembers(knowledgeId: string): Promise<JavaKnowledgeMember[]> {
    if (!KNOWLEDGE_UUID.test(knowledgeId)) throw new Error('知识库ID格式无效')
    const members: JavaKnowledgeMember[] = []
    for (let page = 1; ; page += 1) {
      const data = this.parsePage(
        await this.json(
          `/api/v1/knowledge/member/page${this.query({ scope: 'client', knowledgeId, page, pageSize: 100 })}`
        ),
        '知识库成员'
      )
      for (const entry of data.items) {
        members.push(knowledgeMemberVOSchema.parse(object(entry)) as JavaKnowledgeMember)
      }
      if (page * 100 >= data.total) break
      if (data.items.length === 0) throw new Error('知识库成员分页不完整，请刷新后重试')
    }
    return members
  }

  /** 创建接收客户端预计算内容的线上知识库（id 由服务端生成）。 */
  async createLocalShare(
    name: string,
    allowLocalFileUpload: boolean,
    beforeSend?: () => void
  ): Promise<JavaKnowledgeSpace> {
    if (!name || !name.trim()) throw new Error('知识库名称不能为空')
    return knowledgeVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/localShare/add',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, allowLocalFileUpload })
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeSpace
  }

  /** 删除当前企业知识库。 */
  async removeSpace(id: string, beforeSend?: () => void): Promise<void> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    await this.json(
      '/api/v1/knowledge/remove',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'client', id })
      },
      beforeSend
    )
  }

  /** 重命名当前企业知识库，校验返回归属。 */
  async renameSpace(id: string, name: string, beforeSend?: () => void): Promise<JavaKnowledgeSpace> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!name || !name.trim()) throw new Error('知识库名称不能为空')
    const space = knowledgeVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/edit',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'client', id, name })
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeSpace
    assertAttribution(space.id, id, '详情')
    return space
  }

  /** 在知识库内新建目录，校验返回知识库归属。 */
  async createFolder(id: string, name: string, parentId?: string, beforeSend?: () => void): Promise<JavaKnowledgeFile> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!name || !name.trim()) throw new Error('目录名称不能为空')
    if (parentId !== undefined && !HEX32.test(parentId)) throw new Error('父目录ID格式无效')
    const file = knowledgeFileVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/folder/add',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'client', id, name, parentId })
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeFile
    assertAttribution(file.knowledgeId, id, '文件')
    return file
  }

  /** 删除知识库内文件或目录。 */
  async removeFile(id: string, fileId: string, beforeSend?: () => void): Promise<void> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    await this.json(
      '/api/v1/knowledge/file/remove',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'client', id, fileId })
      },
      beforeSend
    )
  }

  /** 重命名知识库内文件或目录，校验返回知识库归属。 */
  async renameFile(id: string, fileId: string, name: string, beforeSend?: () => void): Promise<JavaKnowledgeFile> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(fileId)) throw new Error('文件ID格式无效')
    if (!name || !name.trim()) throw new Error('文件名称不能为空')
    const file = knowledgeFileVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/file/edit',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'client', id, fileId, name })
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeFile
    assertAttribution(file.knowledgeId, id, '文件')
    return file
  }

  /** 创建企业内部只读分享链接，写返回必检 shareId。 */
  async createShare(
    id: string,
    params: { password?: string; maxViews?: number; expireDays: number | null },
    beforeSend?: () => void
  ): Promise<JavaKnowledgeShare> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    const body: Record<string, unknown> = { scope: 'client', id }
    if (params.password !== undefined) body.password = params.password
    if (params.maxViews !== undefined) body.maxViews = params.maxViews
    body.expireDays = params.expireDays
    const share = knowledgeShareVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/share/add',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeShare
    if (!share.shareId) throw new Error('分享创建响应缺少分享ID')
    return share
  }

  /** 吊销知识库分享链接。 */
  async revokeShare(id: string, shareId: string, beforeSend?: () => void): Promise<void> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!HEX32.test(shareId)) throw new Error('分享ID格式无效')
    await this.json(
      '/api/v1/knowledge/share/remove',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'client', id, shareId })
      },
      beforeSend
    )
  }

  /** 登录后领取本企业分享，返回解析后的知识库。 */
  async receiveShare(
    params: { shareCode: string; password?: string },
    beforeSend?: () => void
  ): Promise<JavaKnowledgeSpace> {
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(params.shareCode)) throw new Error('分享码格式无效')
    const body: Record<string, unknown> = { shareCode: params.shareCode }
    if (params.password !== undefined) body.password = params.password
    return knowledgeVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/share/receive',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeSpace
  }

  /** 搜索当前企业有效成员（knowledgeId 服务端强制必填）。 */
  async memberOptions(
    params: { knowledgeId: string; keyword?: string; page?: number; pageSize?: number },
    beforeSend?: () => void
  ): Promise<JavaKnowledgePage<JavaKnowledgeMemberOption>> {
    if (!KNOWLEDGE_UUID.test(params.knowledgeId)) throw new Error('知识库ID格式无效')
    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 100
    const data = this.parsePage(
      await this.json(
        `/api/v1/knowledge/member/options${this.query({
          knowledgeId: params.knowledgeId,
          keyword: params.keyword,
          page,
          pageSize
        })}`,
        undefined,
        beforeSend
      ),
      '知识库成员选项'
    )
    const items = data.items.map(
      (entry) => knowledgeMemberOptionVOSchema.parse(object(entry)) as JavaKnowledgeMemberOption
    )
    return { items, total: data.total, page, pageSize }
  }

  /** 发送只读成员邀请。 */
  async addMember(
    id: string,
    userId: number,
    expireDays?: number,
    beforeSend?: () => void
  ): Promise<JavaKnowledgeMember> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('用户ID无效')
    if (expireDays !== undefined && (!Number.isInteger(expireDays) || expireDays < 1 || expireDays > 30)) {
      throw new Error('邀请有效期无效')
    }
    const body: Record<string, unknown> = { scope: 'client', id, userId }
    if (expireDays !== undefined) body.expireDays = expireDays
    return knowledgeMemberVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/member/add',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeMember
  }

  /** 移除成员或撤销待接受邀请。 */
  async removeMember(id: string, userId: number, beforeSend?: () => void): Promise<void> {
    if (!KNOWLEDGE_UUID.test(id)) throw new Error('知识库ID格式无效')
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('用户ID无效')
    await this.json(
      '/api/v1/knowledge/member/remove',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'client', id, userId })
      },
      beforeSend
    )
  }

  /** 本人待处理邀请跨页取全量。 */
  async listInvitations(beforeSend?: () => void): Promise<JavaKnowledgeInvitation[]> {
    const invitations: JavaKnowledgeInvitation[] = []
    for (let page = 1; ; page += 1) {
      const data = this.parsePage(
        await this.json(
          `/api/v1/knowledge/invitation/page${this.query({ page, pageSize: 100 })}`,
          undefined,
          beforeSend
        ),
        '知识库邀请'
      )
      for (const entry of data.items) {
        invitations.push(knowledgeInvitationVOSchema.parse(object(entry)) as JavaKnowledgeInvitation)
      }
      if (page * 100 >= data.total) break
      if (data.items.length === 0) throw new Error('知识库邀请分页不完整，请刷新后重试')
    }
    return invitations
  }

  /** 接受本人有效邀请，返回成员。 */
  async acceptInvitation(invitationId: string, beforeSend?: () => void): Promise<JavaKnowledgeMember> {
    if (!HEX32.test(invitationId)) throw new Error('邀请ID格式无效')
    return knowledgeMemberVOSchema.parse(
      object(
        await this.json(
          '/api/v1/knowledge/invitation/accept',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ invitationId })
          },
          beforeSend
        )
      )
    ) as JavaKnowledgeMember
  }

  /** 拒绝本人有效邀请。 */
  async declineInvitation(invitationId: string, beforeSend?: () => void): Promise<void> {
    if (!HEX32.test(invitationId)) throw new Error('邀请ID格式无效')
    await this.json(
      '/api/v1/knowledge/invitation/decline',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invitationId })
      },
      beforeSend
    )
  }

  /** 当前企业可核对操作分页（普通成员仅查看本人）。 */
  async listOperations(page?: number, beforeSend?: () => void): Promise<JavaKnowledgePage<JavaKnowledgeOperation>> {
    const current = page ?? 1
    const pageSize = 100
    const data = this.parsePage(
      await this.json(
        `/api/v1/knowledge/operation/page${this.query({ page: current, pageSize })}`,
        undefined,
        beforeSend
      ),
      '知识库操作'
    )
    const items = data.items.map((entry) => knowledgeOperationVOSchema.parse(object(entry)) as JavaKnowledgeOperation)
    return { items, total: data.total, page: current, pageSize }
  }

  /** 按操作ID重新核对已保存结果，不重放远端请求；确认删除后 data 为 null。 */
  async confirmOperation(operationId: number, beforeSend?: () => void): Promise<JavaKnowledgeSpace | null> {
    if (!Number.isInteger(operationId) || operationId <= 0) throw new Error('操作ID无效')
    const data = await this.json(
      '/api/v1/knowledge/operation/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: operationId })
      },
      beforeSend
    )
    if (data === null || data === undefined) return null
    return knowledgeVOSchema.parse(object(data)) as JavaKnowledgeSpace
  }
}
