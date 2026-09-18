/**
 * [enterprise] T0 企业扩展 - MCP 连接器目录：企业下发 → McpServerService.create(installSource='org')
 * T0 仅直连型 SSE；代理型二期。
 */
import { loggerService } from '@logger'
import { mcpServerService } from '@data/services/McpServerService'
import type { OrgConnectorCatalogItem } from './types'

const logger = loggerService.withContext('OrgMcpCatalog')

export class OrgMcpCatalog {
  constructor(private readonly auth: import('./OrgAuthManager').OrgAuthManager) {}

  async list(): Promise<OrgConnectorCatalogItem[]> {
    const { connectors } = await this.auth.apiClient.listConnectors()
    return connectors
  }

  /** 安装连接器为企业 MCP 服务器（直连 SSE，本地直连使用，不经服务端代理） */
  async install(slug: string): Promise<void> {
    const catalog = await this.list()
    const item = catalog.find((c) => c.slug === slug)
    if (!item) throw new Error(`企业连接器不存在: ${slug}`)

    const created = mcpServerService.create({
      name: item.name,
      description: item.description,
      type: 'sse',
      baseUrl: item.baseUrl,
      isActive: false, // 安装与启用分离：默认不启用，用户确认后手动开
      installSource: 'org'
    } as Parameters<typeof mcpServerService.create>[0])

    logger.info('org connector installed as mcp server', { slug, mcpId: created.id })
  }
}
