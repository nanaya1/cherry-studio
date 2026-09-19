/**
 * [enterprise] T0 企业扩展 - MCP 连接器目录：企业下发 → McpServerService.create(installSource='org')
 * T0 仅直连型 SSE；代理型二期。
 * C6 扩展：compareAndSync（新增安装 / baseUrl 变更更新 / 目录缺失禁用），本地映射记于 OrgStateStore。
 */
import { loggerService } from '@logger'
import { mcpServerService } from '@data/services/McpServerService'
import { orgStateStore } from './OrgStateStore'
import type { OrgConnectorCatalogItem } from './types'

const logger = loggerService.withContext('OrgMcpCatalog')

export class OrgMcpCatalog {
  constructor(private readonly auth: import('./OrgAuthManager').OrgAuthManager) {}

  async list(): Promise<OrgConnectorCatalogItem[]> {
    const { connectors } = await this.auth.apiClient.listConnectors()
    return connectors
  }

  /**
   * [enterprise] C6 连接器同步：对比服务端目录与本地 org 连接器（by slug + baseUrl）。
   * - 目录新增 → 自动安装（isActive=false，安装与启用分离）
   * - baseUrl 变更 → update 本地 MCP 服务器
   * - 目录缺失 → 本地禁用（isActive=false），不删除（企业可能临时下架）
   * 单项失败不阻塞其余项；整体拉取失败静默跳过（等下次扫描重试）。
   */
  async compareAndSync(): Promise<{ installed: string[]; updated: string[]; disabled: string[] }> {
    const installed: string[] = []
    const updated: string[] = []
    const disabled: string[] = []

    let catalog: OrgConnectorCatalogItem[]
    try {
      catalog = await this.list()
    } catch (error) {
      logger.warn('compareAndSync skipped: catalog unreachable', { error: String(error) })
      return { installed, updated, disabled }
    }

    const remote = new Map(catalog.map((c) => [c.slug, c]))
    const local = orgStateStore.snapshotConnectors()

    // 新增 & 变更
    for (const [slug, item] of remote) {
      const state = local[slug]
      try {
        if (!state) {
          this.installLocal(item)
          orgStateStore.upsertConnector(slug, { mcpId: this.lastCreatedId, baseUrl: item.baseUrl })
          installed.push(slug)
        } else if (state.baseUrl !== item.baseUrl) {
          mcpServerService.update(state.mcpId, { baseUrl: item.baseUrl } as never)
          orgStateStore.upsertConnector(slug, { mcpId: state.mcpId, baseUrl: item.baseUrl })
          updated.push(slug)
        }
      } catch (error) {
        logger.warn('compareAndSync item failed', { slug, error: String(error) })
      }
    }

    // 目录缺失 → 禁用不删除
    for (const [slug, state] of Object.entries(local)) {
      if (remote.has(slug)) continue
      try {
        const current = mcpServerService.getByIdSafe(state.mcpId)
        if (current?.isActive) {
          mcpServerService.update(state.mcpId, { isActive: false } as never)
        } else if (!current) {
          // [enterprise] 本地已被用户手动删除 → 仅清 state 映射
          orgStateStore.removeConnector(slug)
        }
        disabled.push(slug)
      } catch (error) {
        logger.warn('compareAndSync disable failed', { slug, error: String(error) })
      }
    }

    if (installed.length || updated.length || disabled.length) {
      logger.info('compareAndSync done', { installed, updated, disabled })
    }
    return { installed, updated, disabled }
  }

  // [enterprise] installLocal 记录最近一次 create 的 id，供 state 写入
  private lastCreatedId = ''

  private installLocal(item: OrgConnectorCatalogItem): void {
    const created = mcpServerService.create({
      name: item.name,
      description: item.description,
      type: 'sse',
      baseUrl: item.baseUrl,
      isActive: false, // 安装与启用分离：默认不启用，用户确认后手动开
      installSource: 'org'
    } as Parameters<typeof mcpServerService.create>[0])
    this.lastCreatedId = created.id
    logger.info('org connector installed as mcp server', { slug: item.slug, mcpId: created.id })
  }

  /** 安装连接器为企业 MCP 服务器（直连 SSE，本地直连使用，不经服务端代理） */
  async install(slug: string): Promise<void> {
    const catalog = await this.list()
    const item = catalog.find((c) => c.slug === slug)
    if (!item) throw new Error(`企业连接器不存在: ${slug}`)

    // [enterprise] C6：手动安装同样记录 state，纳入 compareAndSync 管理
    this.installLocal(item)
    orgStateStore.upsertConnector(slug, { mcpId: this.lastCreatedId, baseUrl: item.baseUrl })
  }
}
