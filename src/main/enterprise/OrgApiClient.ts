import { randomUUID } from 'node:crypto'
/**
 * [enterprise] T0 企业扩展 - 企业服务 HTTP 客户端
 * 薄封装：base URL 常量 + 统一 Authorization 头 + json 解析。
 */
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

import { loggerService } from '@logger'

import type {
  OrgConnectorCatalogItem,
  OrgCurrentUser,
  OrgSession,
  OrgSkillCatalogItem,
  RawOrgSkillFacet
} from './types'

const logger = loggerService.withContext('OrgApiClient')

/**
 * 管理端地址（区别于雪浪网关 XUELANG_API_ORIGIN / Cherry Cloud MAIN_VITE_CHERRY_CLOUD_API_ORIGIN）。
 * 有值时启用管理端 Exchange；无值时启用官网直连模式。
 */
function resolveOrgServerBaseUrl(): string | null {
  const configured = import.meta.env.MAIN_VITE_ORG_SERVER_BASE_URL?.trim()
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    throw new Error(`MAIN_VITE_ORG_SERVER_BASE_URL 不是合法 URL: ${configured}`)
  }
}

function resolveOfficialApiBaseUrl(): string {
  const configured = import.meta.env.MAIN_VITE_OFFICIAL_API_BASE_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      throw new Error(`MAIN_VITE_OFFICIAL_API_BASE_URL 不是合法 URL: ${configured}`)
    }
  }

  const loginUrl = import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim() || 'https://mro.xuelangyun.com/login'
  try {
    return new URL(loginUrl).origin
  } catch {
    throw new Error(`MAIN_VITE_OFFICIAL_LOGIN_URL 不是合法 URL: ${loginUrl}`)
  }
}

export type OrgAuthMode = 'management-exchange' | 'management-oauth' | 'management-cookie' | 'official-direct'
export const ORG_SERVER_BASE_URL = resolveOrgServerBaseUrl()
export const OFFICIAL_LOGIN_CONFIGURED = Boolean(import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim())
export const ORG_AUTH_MODE: OrgAuthMode = OFFICIAL_LOGIN_CONFIGURED
  ? ORG_SERVER_BASE_URL
    ? 'management-exchange'
    : 'official-direct'
  : ORG_SERVER_BASE_URL
    ? 'management-oauth'
    : 'official-direct'
export const OFFICIAL_API_BASE_URL = resolveOfficialApiBaseUrl()

export function getOrgApiBaseUrl(): string {
  return ORG_SERVER_BASE_URL ?? OFFICIAL_API_BASE_URL
}

/**
 * 组织服务 HTTP 错误：携带服务端 HTTP status，便于上层映射为领域 {@link IpcError} 码（fail closed）。
 */
export class OrgApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'OrgApiHttpError'
  }
}

export class OrgApiClient {
  // [enterprise] 修复 401：改为异步取「有效期内的会话」（过期自动刷新）。
  // 原同步裸取：constructor(private readonly getSession: () => OrgSession | null) {}
  constructor(
    private readonly getValidSession: () => Promise<OrgSession | null>,
    private readonly cookieFetch?: (url: string, init: RequestInit) => Promise<Response>
  ) {}

  private async shareHttpError(response: Response): Promise<never> {
    let message = `账户服务请求失败 (${response.status})`
    try {
      const body = await response.json()
      if (typeof body?.detail === 'string') message = body.detail
      else if (typeof body?.message === 'string') message = body.message
      // MEA:enterprise-knowledge-page modern 代理以 error 字符串返回知识库校验原因。
      else if (typeof body?.error === 'string') message = body.error
    } catch {
      /* 非 JSON 错误保留状态，不记录响应体。 */
    }
    logger.info('knowledge api request failed', {
      status: response.status,
      url: response.url ? new URL(response.url).origin + new URL(response.url).pathname : undefined,
      error: message
    })
    throw new OrgApiHttpError(response.status, message)
  }

  /** 统一会话传输、client scope 与明确 401 后的一次刷新重试。 */
  // private async sendAuth(path: string, init: RequestInit = {}): Promise<Response> {
  private async sendAuth(
    path: string,
    init: RequestInit = {},
    assertSession?: (session?: OrgSession) => void
  ): Promise<Response> {
    // const isShare = /^\/api\/kb\/v1\/(shares\/|spaces\/[^/]+\/shares(?:\/|\?|$))/.test(path)
    // MEA:enterprise-knowledge-page 副本创建、上传和云端空间改名均保留服务端错误详情。
    const isShare =
      /^\/api\/(?:kb\/v1\/(?:local-share(?:\/|\?|$)|shares\/|spaces\/[^/]+\/shares(?:\/|\?|$))|v1\/(?:local-share(?:\/|\?|$)|spaces\/[^/]+$))/.test(
        path
      )
    // MEA:enterprise-knowledge-page DELETE 在凭据获取前后校验原操作身份，且禁止401重放。
    const destructive = init.method === 'DELETE' && path.startsWith('/api/kb/v1/')
    assertSession?.()
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录')
    assertSession?.(session)
    const target = new URL(`${getOrgApiBaseUrl()}${path}`)
    // 客户端始终按分组权限访问知识库，管理员会话也不能绕过 client scope。
    if (target.pathname.startsWith('/api/kb/v1/') || target.pathname === '/api/kb/catalog') {
      target.searchParams.set('scope', 'client')
    }
    const url = target.toString()
    const isForm = init.body instanceof FormData
    const jsonHeaders = (): Record<string, string> => ({
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined)
    })

    if (session.authMode === 'management-cookie') {
      if (!this.cookieFetch) throw new Error('Cookie transport is unavailable')
      const response = await this.cookieFetch(url, {
        ...init,
        credentials: 'include',
        redirect: 'error',
        headers: isForm ? init.headers : jsonHeaders()
      })
      if (!response.ok && isShare) return this.shareHttpError(response)
      if (!response.ok) throw new OrgApiHttpError(response.status, `账户服务请求失败 (${response.status})`)
      return response
    }

    const bearerFetch = (token: string) =>
      fetch(url, {
        ...init,
        headers: {
          ...(isForm ? init.headers : jsonHeaders()),
          authorization: `Bearer ${token}`
        }
      })

    const res = await bearerFetch(session.accessToken)
    // [enterprise] 修复 401：access token 被服务端提前吊销时兜底——刷新一次重试一次
    // if (res.status === 401) {
    if (res.status === 401 && !destructive && !(assertSession && /^\/api\/(?:kb\/v1|v1)\/local-share\//.test(path))) {
      const refreshed = await this.getValidSession()
      if (!refreshed || refreshed.accessToken === session.accessToken) {
        throw new OrgApiHttpError(401, '账户服务请求失败 (401)')
      }
      const retry = await bearerFetch(refreshed.accessToken)
      if (!retry.ok && isShare) return this.shareHttpError(retry)
      if (!retry.ok) {
        const body = await retry.text().catch(() => '')
        logger.warn('org api request failed', { path, status: retry.status, body: body.slice(0, 200) })
        throw new OrgApiHttpError(retry.status, `账户服务请求失败 (${retry.status})`)
      }
      return retry
    }
    if (!res.ok && isShare) return this.shareHttpError(res)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn('org api request failed', { path, status: res.status, body: body.slice(0, 200) })
      throw new OrgApiHttpError(res.status, `账户服务请求失败 (${res.status})`)
    }
    return res
  }

  /**
   * JSON 请求：解析 JSON 响应；空响应体返回 undefined。兼容既有技能/连接器调用。
   */
  // private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
  private async request<T>(
    path: string,
    init: RequestInit = {},
    assertSession?: (session?: OrgSession) => void
  ): Promise<T> {
    // const res = await this.sendAuth(path, init)
    const res = await this.sendAuth(path, init, assertSession)
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  /**
   * multipart 上传（如本地共享逐文件上传）。FormData 不设置 application/json，
   * boundary 由 fetch 自行决定；解析 JSON 响应，空响应体返回 undefined。
   */
  async requestMultipart<T>(path: string, form: FormData): Promise<T> {
    const res = await this.sendAuth(path, { method: 'POST', body: form })
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  // MEA:enterprise-knowledge-page 消费一次的流不经过401重放，文件数据始终受背压约束。
  async requestFileMultipart<T>(
    path: string,
    // file: { path: string; fileName: string; size: number; chunks: unknown[]; hash?: string },
    file: {
      path: string
      fileName: string
      size: number
      chunks: unknown[]
      hash?: string
      parentId?: string | null
      // MEA:enterprise-knowledge-page 可选不上传源文件：缺省（undefined/true）发送原件字节；
      // 显式 false 仅发送元数据（file_name/chunks/parent_id），不读取原件、不校验原件哈希。
      uploadOriginal?: boolean
    },
    progress: (bytes: number) => void,
    assertSession?: (session?: OrgSession) => void,
    beforeStop?: (error: unknown) => void,
    signal?: AbortSignal
  ): Promise<T> {
    assertSession?.()
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录')
    assertSession?.(session)
    const boundary = `mea-${randomUUID()}`
    const name = file.fileName.replace(/[\r\n"\\]/g, '_')
    // 临时诊断上传表单字段大小，排查服务端multipart限制。
    logger.info('knowledge upload chunks', {
      fileName: file.fileName,
      chunkCount: file.chunks.length,
      chunksBytes: Buffer.byteLength(JSON.stringify(file.chunks), 'utf8'),
      chunks: file.chunks
    })
    // MEA:enterprise-knowledge-page uploadOriginal !== false 才发送原件字节并校验哈希；
    // 否则仅发送元数据（file_name/chunks/parent_id），进度不读原件，避免传输/核对依赖本地文件。
    const uploadOriginal = file.uploadOriginal !== false
    const parentField = file.parentId
      ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parent_id"\r\n\r\n${file.parentId}\r\n`)
      : Buffer.alloc(0)
    // 原文本分块字段：`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${file.fileName}\r\n--${boundary}\r\nContent-Disposition: form-data; name="chunks"\r\n\r\n${JSON.stringify(file.chunks)}\r\n`
    // 分块作为 JSON 文件，避免普通表单字段触发服务端 1MiB 限制。
    const metaPrefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${file.fileName}\r\n--${boundary}\r\nContent-Disposition: form-data; name="chunks_file"; filename="chunks.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(file.chunks)}\r\n`
    )
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
    // const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
    // 元数据末尾已有换行；原件字节后才需要补上边界前的换行。
    const suffix = Buffer.from(`${uploadOriginal ? '\r\n' : ''}--${boundary}--\r\n`)
    async function* body() {
      yield parentField
      yield metaPrefix
      if (uploadOriginal) {
        yield fileHeader
        let bytes = 0
        const fingerprint = (await import('node:crypto')).createHash('sha256')
        for await (const chunk of createReadStream(file.path)) {
          if (source.destroyed) return
          fingerprint.update(chunk)
          bytes += chunk.length
          if (bytes > file.size) throw new Error('上传期间文件大小发生变化')
          resetTimeout()
          progress(bytes)
          yield chunk
        }
        if (bytes !== file.size) throw new Error('上传期间文件大小发生变化')
        if (file.hash && fingerprint.digest('hex') !== file.hash)
          throw new Error('上传期间文件内容发生变化，结果需核对')
      } else {
        // MEA:enterprise-knowledge-page 元数据模式单跳到满进度，不读取原件字节。
        resetTimeout()
        progress(file.size)
      }
      yield suffix
    }
    const target = new URL(`${getOrgApiBaseUrl()}${path}`)
    target.searchParams.set('scope', 'client')
    // 原对象输出：logger.info('knowledge upload request parameters', { ... })
    logger.info(
      'knowledge upload request parameters\n' +
        JSON.stringify(
          {
            method: 'POST',
            url: target.toString(),
            contentType: `multipart/form-data; boundary=${boundary}`,
            contentLength:
              parentField.length +
              metaPrefix.length +
              (uploadOriginal ? fileHeader.length + file.size : 0) +
              suffix.length,
            parameters: {
              file_name: file.fileName,
              ...(file.parentId ? { parent_id: file.parentId } : {}),
              chunks: JSON.stringify(file.chunks),
              ...(uploadOriginal
                ? {
                    file: { path: file.path, filename: name, size: file.size, contentType: 'application/octet-stream' }
                  }
                : { uploadOriginal: false })
            }
          },
          null,
          2
        )
    )
    const source = Readable.from(body())
    const controller = new AbortController()
    // MEA:enterprise-knowledge-page 持续上传可超过5分钟；仅无字节进展或响应时中止。
    const timer = setTimeout(() => {
      const error = new DOMException('上传无进展超时，结果需核对', 'TimeoutError')
      try {
        beforeStop?.(error)
      } catch (persistError) {
        logger.error('首次分享清理意图持久化失败', { error: String(persistError) })
      } finally {
        controller.abort(error)
        source.destroy()
      }
    }, 5 * 60_000)
    const resetTimeout = () => timer.refresh()
    const stop = () => {
      try {
        beforeStop?.(signal?.reason)
      } finally {
        controller.abort(signal?.reason)
        source.destroy()
      }
    }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const init: RequestInit & { duplex: 'half' } = {
      signal: controller.signal,
      method: 'POST',
      redirect: 'error',
      duplex: 'half',
      // body: Readable.toWeb(Readable.from(body())) as ReadableStream<Uint8Array>,
      body: Readable.toWeb(source) as ReadableStream<Uint8Array>,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        // 'content-length': String(prefix.length + file.size + suffix.length)
        'content-length': String(
          parentField.length + metaPrefix.length + (uploadOriginal ? fileHeader.length + file.size : 0) + suffix.length
        )
      }
    }
    /* 原请求路径保留；下方统一清理提前响应或断连后仍在读取的流。
    let response: Response
    if (session.authMode === 'management-cookie') {
      response = await this.requireCookieFetch()(target.toString(), { ...init, credentials: 'include' })
    } else {
      response = await fetch(target, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${session.accessToken}` }
      })
    }
    if (!response.ok) return this.shareHttpError(response)
    return (await response.json()) as T
    */
    try {
      // MEA:enterprise-knowledge-page Chromium流式上传拒绝手设Content-Length，Cookie传输交由网络栈分帧。
      if (session.authMode === 'management-cookie') delete (init.headers as Record<string, string>)['content-length']
      const response =
        session.authMode === 'management-cookie'
          ? await this.requireCookieFetch()(target.toString(), { ...init, credentials: 'include' })
          : await fetch(target, {
              ...init,
              headers: { ...init.headers, authorization: `Bearer ${session.accessToken}` }
            })
      resetTimeout()
      if (!response.ok) return await this.shareHttpError(response)
      return (await response.json()) as T
    } catch (error) {
      beforeStop?.(error)
      controller.abort(error)
      controller.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      // MEA:enterprise-knowledge-page 传输提前结束时关闭文件读取，避免后台继续回调进度。
      source.destroy()
      await finished(source).catch(() => {})
    }
  }

  /** 拉取纯文本响应（如签名 URL 指向的原文预览内容）。主进程内部使用，不向渲染进程暴露 URL。 */
  async requestText(path: string): Promise<string> {
    // 原10MiB限制停用，与modern完整读取预览一致。
    // return (await this.requestBytes(path, 10 * 1024 * 1024)).toString('utf8')
    return (await this.requestBytes(path)).toString('utf8')
  }

  // async requestBytes(path: string, maxBytes: number): Promise<Buffer> {
  async requestBytes(path: string): Promise<Buffer> {
    const res = await this.sendAuth(path, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000) })
    /* 停用预览声明长度阈值，保留原逻辑便于恢复。
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel()
      throw new Error('预览文件超过大小限制')
    }
    */
    if (!res.body) return Buffer.alloc(0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    // let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // size += value.byteLength
        // if (size > maxBytes) throw new Error('预览文件超过大小限制')
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }

  // MEA:enterprise-knowledge-page 原件恢复直接流式落盘，磁盘错误向上传播。
  async downloadKnowledgeFile(fileId: string, destination: string): Promise<void> {
    const { createWriteStream } = await import('node:fs')
    const { pipeline } = await import('node:stream/promises')
    const response = await this.sendAuth(`/api/kb/v1/files/${encodeURIComponent(fileId)}/download`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.body) throw new Error('原件下载响应为空')
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    )
  }

  private requireCookieFetch() {
    if (!this.cookieFetch) throw new Error('Cookie transport is unavailable')
    return this.cookieFetch
  }

  private async send(path: string, accessToken: string, init: RequestInit): Promise<Response> {
    return fetch(`${getOrgApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...init.headers
      }
    })
  }

  // modern 未提供 /api/server-identity；server_instance_id 由 /api/currentuser 返回。
  // getServerIdentity(): Promise<OrgServerIdentity> { return this.request('/api/server-identity') }
  getCurrentUser(): Promise<OrgCurrentUser> {
    return this.request('/api/currentuser')
  }

  async revoke(refreshToken: string, logoutSession?: OrgSession): Promise<unknown> {
    if (logoutSession) {
      const init = {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(10_000)
      }
      const response =
        logoutSession.authMode === 'management-cookie'
          ? await this.requireCookieFetch()(`${getOrgApiBaseUrl()}/api/auth/logout`, {
              ...init,
              credentials: 'include',
              redirect: 'error',
              headers: { 'content-type': 'application/json' }
            })
          : await this.send('/api/auth/logout', logoutSession.accessToken, init)
      if (!response.ok) throw new Error(`账户服务请求失败 (${response.status})`)
      return
    }
    // modern 未提供 /api/auth/revoke；登出接口负责撤销 refresh 及其关联 access token。
    // return this.request('/api/auth/revoke', {
    return this.request('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    })
  }

  // 原 publicRequest 匿名目录读取已停用：modern 服务端必须根据 Bearer token 的实时 group_id 做权限裁剪。
  // private async publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> { ... }

  // [enterprise] tags/categories 服务端有字符串数组与对象数组两种形态，归一化在 OrgSkillCatalog.list
  async listSkills() {
    type SkillItem = Omit<OrgSkillCatalogItem, 'categories' | 'tags'> & {
      status?: string
      categories?: RawOrgSkillFacet[]
      tags?: RawOrgSkillFacet[]
    }
    const skills: SkillItem[] = []
    const pageSize = 100
    for (let page = 1; ; page += 1) {
      const result = await this.request<{ items: SkillItem[]; total?: number }>(
        `/api/library-items?page=${page}&pageSize=${pageSize}`
      )
      skills.push(...result.items.filter((item) => item.status === undefined || item.status === 'ready'))
      if (result.items.length < pageSize || page * pageSize >= (result.total ?? 0)) break
    }
    return { skills }
  }

  async listConnectors() {
    const result = await this.request<{
      items: Array<{ id: number; key: string; config: Record<string, unknown> }>
    }>('/api/mcp-servers')
    return {
      connectors: result.items.map((item): OrgConnectorCatalogItem => {
        const config = item.config
        const type = config.type === 'stdio' || config.type === 'streamableHttp' ? config.type : 'sse'
        return {
          slug: item.key || String(item.id),
          name: typeof config.name === 'string' ? config.name : item.key,
          description: typeof config.description === 'string' ? config.description : '',
          type,
          baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
          config
        }
      })
    }
  }

  /**
   * 下载技能包到指定目录。返回本地 tar.gz 路径。
   * hash 校验由调用方（OrgSkillCatalog）完成后解包。
   */
  async downloadSkill(slug: string, destPath: string, expectedHash: string): Promise<void> {
    const { createWriteStream } = await import('node:fs')
    const { createHash } = await import('node:crypto')

    // [enterprise] 修复 401：与 request() 一致改走异步 getValidSession（原裸 getSession 注释保留）
    // const session = this.getSession()
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录')
    // const res = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` } })
    const url = `${getOrgApiBaseUrl()}/api/skills/${slug}/download`
    const res =
      session.authMode === 'management-cookie'
        ? await this.requireCookieFetch()(url, { credentials: 'include', redirect: 'error' })
        : await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'omit' })
    if (!res.ok || !res.body) throw new Error(`技能包下载失败 (${res.status})`)

    const hash = createHash('sha256')
    const file = createWriteStream(destPath)
    // 边写边算 hash，落盘完成后与目录声明的 contentHash 比对
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      chunks.push(buf)
      hash.update(buf)
    }
    await new Promise<void>((resolve, reject) => {
      file.on('finish', () => resolve())
      file.on('error', reject)
      for (const chunk of chunks) file.write(chunk)
      file.end()
    })
    const actual = hash.digest('hex')
    if (actual !== expectedHash) {
      throw new Error(`技能包校验失败：期望 ${expectedHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
  }

  reportLifecycle(skillSlug: string, event: string, detail: Record<string, unknown> = {}) {
    // 上报失败不阻塞主流程。不在此处预取会话：会话获取与 401 刷新重试完全由 request() 驱动，
    // 预取会多消耗一次 getValidSession 并干扰 request() 的「token 未变化则不重试」判断。
    // 匿名（未登录）时 request() 抛「未登录」，这里等价于跳过上报。
    return this.request('/api/skills/lifecycle', {
      method: 'POST',
      body: JSON.stringify({ skillSlug, event, detail })
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '未登录') {
        logger.info('lifecycle report skipped: signed out', { skillSlug, event })
        return undefined
      }
      logger.warn('lifecycle report failed', { skillSlug, event, error: message })
      return undefined
    })
  }
}
