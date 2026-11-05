import { javaResponseErrorMessage } from './JavaResponseError'
import type { OrgSkillFacet } from './types'

export interface JavaResourceIdentity {
  id: string
  tenantId: string | null
  slug: string
  name: string
  description: string
  iconFileCode: string | null
}

export interface JavaSkillResource extends JavaResourceIdentity {
  version: string
  contentHash: string
  packageFileCode: string
  categories: OrgSkillFacet[]
  tags: OrgSkillFacet[]
}

export interface JavaConnectorResource extends JavaResourceIdentity {
  type: 'stdio' | 'sse' | 'streamableHttp' | null
  baseUrl: string
  config: Record<string, unknown>
  configurationError: string | null
}

export interface JavaSkillLifecycleEvent {
  id: string
  eventId: string
  event: 'install' | 'exec'
  version: string
  contentHash: string
}

interface JavaResourceClientOptions {
  baseUrl: string
  getAccessToken: () => Promise<string>
  onSessionExpired: () => void | Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class JavaResourceError extends Error {
  constructor(
    public readonly code: number,
    msg?: unknown,
    requestId?: unknown
  ) {
    super(javaResponseErrorMessage(code, msg, requestId, '企业资源'))
    this.name = 'JavaResourceError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企业资源响应格式无效')
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('资源ID不是有效的安全整数')
  }
  return String(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredText(value: unknown, label: string): string {
  const result = text(value).trim()
  if (!result) throw new Error(`${label}不能为空`)
  return result
}

function facets(value: unknown): OrgSkillFacet[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = object(entry)
    const name = text(item.name).trim()
    return name ? [{ code: text(item.code) || name, name }] : []
  })
}

function identity(raw: Record<string, unknown>): JavaResourceIdentity {
  return {
    id: id(raw.id),
    tenantId: raw.tenantId === null ? null : id(raw.tenantId),
    slug: requiredText(raw.slug, '资源标识'),
    name: text(raw.displayName).trim() || text(raw.name).trim() || text(raw.slug),
    description: text(raw.description),
    iconFileCode: text(raw.iconFileCode) || null
  }
}

/** Native Java resource transport; never forwards management credentials to MCP targets. */
export class JavaResourceClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: JavaResourceClientOptions) {
    this.baseUrl = new URL(options.baseUrl).origin
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async unwrap(value: unknown): Promise<unknown> {
    const envelope = object(value)
    if (envelope.code === 200) return envelope.data
    if (!Number.isInteger(envelope.code)) throw new Error('企业资源响应缺少有效业务状态码')
    if (envelope.code === 10008) await this.options.onSessionExpired()
    throw new JavaResourceError(envelope.code as number, envelope.msg, envelope.requestId)
  }

  private async request<T>(
    path: string,
    consume: (response: Response) => Promise<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const token = await this.options.getAccessToken()
    if (!token) throw new Error('未登录')
    const headers = new Headers(init.headers)
    headers.set('token', token)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error'
      })
      if (!response.ok) {
        if (response.status === 401) await this.options.onSessionExpired()
        throw new Error(`企业资源请求失败 (${response.status})`)
      }
      return await consume(response)
    } catch (error) {
      if (controller.signal.aborted) throw new Error('企业资源请求超时，请重试')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private json(path: string, init?: RequestInit): Promise<unknown> {
    return this.request(path, async (response) => this.unwrap(await response.json()), init)
  }

  async listSkills(): Promise<JavaSkillResource[]> {
    const skills: JavaSkillResource[] = []
    const pageSize = 100
    for (let page = 1; ; page += 1) {
      const data = object(await this.json(`/api/v1/skill/page?page=${page}&pageSize=${pageSize}&scope=all`))
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || (data.total as number) < 0) {
        throw new Error('技能分页响应无效')
      }
      for (const entry of data.items) {
        const raw = object(entry)
        if (raw.enabled !== 1 || raw.status !== 'active') continue
        const contentHash = text(raw.contentHash)
        if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('技能包摘要无效')
        skills.push({
          ...identity(raw),
          contentHash,
          version: requiredText(raw.version, '技能版本'),
          packageFileCode: requiredText(raw.packageFileCode, '技能包文件标识'),
          categories: facets(raw.categories),
          tags: facets(raw.tagItems)
        })
      }
      if (page * pageSize >= (data.total as number)) break
      if (data.items.length === 0) throw new Error('技能分页不完整，请刷新后重试')
    }
    return skills
  }

  async listConnectors(): Promise<JavaConnectorResource[]> {
    const data = await this.json('/api/v1/mcp/list?scope=all')
    if (!Array.isArray(data)) throw new Error('连接器目录响应无效')
    return data.flatMap((entry) => {
      const raw = object(entry)
      if (raw.enabled !== 1 || raw.status !== 'active') return []
      const resource = identity(raw)
      const type =
        raw.transportType === 'streamable_http'
          ? 'streamableHttp'
          : raw.transportType === 'stdio' || raw.transportType === 'sse'
            ? raw.transportType
            : null
      let config: Record<string, unknown> = {}
      let configurationError: string | null = type ? null : '连接器传输类型不受支持'
      try {
        const source =
          raw.configJson == null || raw.configJson === '' ? {} : JSON.parse(requiredText(raw.configJson, '连接器配置'))
        config = object(source)
      } catch {
        configurationError = '连接器配置不可用，请联系管理员'
      }
      const baseUrl = text(raw.baseUrl)
      return [
        {
          ...resource,
          type,
          baseUrl,
          configurationError,
          config: configurationError
            ? {}
            : { ...config, name: resource.name, description: resource.description, baseUrl, type }
        }
      ]
    })
  }

  async readFile(fileCode: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!fileCode) throw new Error('文件标识不能为空')
    return this.request(`/api/v1/file/view/${encodeURIComponent(fileCode)}`, async (response) => {
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
      if (contentType === 'application/json' || contentType.endsWith('+json')) {
        await this.unwrap(await response.json())
        throw new Error('文件接口未返回文件内容')
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.subarray(0, 64).toString('utf8').trimStart().startsWith('{')) {
        let value: unknown
        try {
          value = JSON.parse(bytes.toString('utf8'))
        } catch {
          throw new Error('文件内容无效')
        }
        await this.unwrap(value)
        throw new Error('文件接口未返回文件内容')
      }
      return { bytes, contentType }
    })
  }

  async readIcon(fileCode: string | null): Promise<string | null> {
    if (!fileCode) return null
    try {
      const { bytes, contentType } = await this.readFile(fileCode)
      if (bytes.length > 2 * 1024 * 1024) return null
      const valid =
        (contentType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
        (contentType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) ||
        (contentType === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) ||
        (contentType === 'image/webp' &&
          bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
          bytes.subarray(8, 12).toString('ascii') === 'WEBP')
      return valid ? `data:${contentType};base64,${bytes.toString('base64')}` : null
    } catch {
      return null
    }
  }

  async reportLifecycle(event: JavaSkillLifecycleEvent): Promise<void> {
    const numericId = Number(event.id)
    if (id(numericId) !== event.id) throw new Error('资源ID无效')
    if (
      !/^[a-f0-9]{32}$/.test(event.eventId) ||
      !/^[a-f0-9]{64}$/.test(event.contentHash) ||
      !['install', 'exec'].includes(event.event) ||
      !event.version.trim() ||
      event.version.trim().length > 30 ||
      Array.from(event.version).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      throw new Error('技能生命周期事件无效')
    }
    await this.json('/api/v1/skill/lifecycle/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: numericId,
        eventId: event.eventId,
        event: event.event,
        version: event.version.trim(),
        contentHash: event.contentHash
      })
    })
  }
}
