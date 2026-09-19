/**
 * [enterprise] T0 企业扩展 - 企业服务 HTTP 客户端
 * 薄封装：base URL 常量 + 统一 Authorization 头 + json 解析。
 */
import { loggerService } from '@logger'
import type { OrgConnectorCatalogItem, OrgSession, OrgSkillCatalogItem } from './types'

const logger = loggerService.withContext('OrgApiClient')

// T0 本地联调固定地址；后续由管理端下发/设置项配置
export const ORG_SERVER_BASE_URL = 'http://127.0.0.1:3000'

export class OrgApiClient {
  // [enterprise] 修复 401：改为异步取「有效期内的会话」（过期自动刷新）。
  // 原同步裸取：constructor(private readonly getSession: () => OrgSession | null) {}
  constructor(private readonly getValidSession: () => Promise<OrgSession | null>) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录企业服务')
    const res = await this.send(path, session.accessToken, init)
    // [enterprise] 修复 401：access token 被服务端提前吊销时兜底——刷新一次重试一次
    if (res.status === 401) {
      const refreshed = await this.getValidSession()
      if (!refreshed || refreshed.accessToken === session.accessToken) {
        throw new Error(`企业服务请求失败 (${res.status})`)
      }
      const retry = await this.send(path, refreshed.accessToken, init)
      if (!retry.ok) {
        const body = await retry.text().catch(() => '')
        logger.warn('org api request failed', { path, status: retry.status, body: body.slice(0, 200) })
        throw new Error(`企业服务请求失败 (${retry.status})`)
      }
      return (await retry.json()) as T
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn('org api request failed', { path, status: res.status, body: body.slice(0, 200) })
      throw new Error(`企业服务请求失败 (${res.status})`)
    }
    return (await res.json()) as T
  }

  private async send(path: string, accessToken: string, init: RequestInit): Promise<Response> {
    return fetch(`${ORG_SERVER_BASE_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...init.headers
      }
    })
  }

  listSkills() {
    return this.request<{ skills: OrgSkillCatalogItem[] }>('/api/skills')
  }

  listConnectors() {
    return this.request<{ connectors: OrgConnectorCatalogItem[] }>('/api/connectors')
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
    if (!session) throw new Error('未登录企业服务')
    const res = await fetch(`${ORG_SERVER_BASE_URL}/api/skills/${slug}/download`, {
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
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
    // 上报失败不阻塞主流程
    return this.request('/api/skills/lifecycle', {
      method: 'POST',
      body: JSON.stringify({ skillSlug, event, detail })
    }).catch((error) => logger.warn('lifecycle report failed', { skillSlug, event, error: String(error) }))
  }
}
