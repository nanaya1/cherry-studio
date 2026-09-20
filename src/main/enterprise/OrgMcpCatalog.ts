import { mcpServerService } from '@data/services/McpServerService'
/**
 * [enterprise] T0 企业扩展 - MCP 连接器目录：企业下发 → McpServerService.create(installSource='org')
 * 目录 v2：config 携带完整客户端 MCP DTO（stdio/sse/streamableHttp），与客户端手动添加同构；
 * 仅白名单透传可写字段（CreateMcpServerSchema 校验），名称/类型/连接目标/停用态由目录权威覆盖。
 * C6 扩展：compareAndSync（新增安装 / 期望配置变更更新 / 目录缺失禁用），本地映射记于 OrgStateStore。
 */
import { loggerService } from '@logger'
import type { CreateMcpServerDto } from '@shared/data/api/schemas/mcpServers'
import { UpdateMcpServerSchema } from '@shared/data/api/schemas/mcpServers'

import type { OrgAuthManager } from './OrgAuthManager'
import { orgStateStore } from './OrgStateStore'
import type { OrgConnectorCatalogItem } from './types'

const logger = loggerService.withContext('OrgMcpCatalog')

/**
 * 目录 item → 本地 create DTO。config 先过 UpdateMcpServerSchema 白名单（丢弃 id/createdAt 等
 * 只读字段，含防御性剥离；目录字段权威覆盖在展开之后），再用目录权威字段覆盖。
 * 旧服务端 config={} 时退化为 sse + baseUrl（行为与目录 v1 一致）。
 */
function toCreateDto(item: OrgConnectorCatalogItem): CreateMcpServerDto {
  const parsed = UpdateMcpServerSchema.safeParse(item.config)
  const fromConfig = parsed.success ? parsed.data : {}
  if (!parsed.success) {
    logger.warn('org connector config invalid, falling back to legacy fields', { slug: item.slug })
  }
  return {
    ...fromConfig,
    name: item.name,
    description: item.description,
    type: item.type,
    // stdio 无 baseUrl：不写空串，避免与本地行的 undefined 形成每次同步的假 drift
    ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
    isActive: false, // 安装与启用分离：默认不启用，用户确认后手动开
    installSource: 'manual',
    tags: Array.from(new Set([...(fromConfig.tags ?? []), 'org']))
  }
}

export class OrgMcpCatalog {
  constructor(private readonly auth: OrgAuthManager) {}

  async list(): Promise<OrgConnectorCatalogItem[]> {
    const { connectors } = await this.auth.apiClient.listConnectors()
    this.backfillCopyTags(connectors)
    return connectors
  }

  private backfillCopyTags(catalog: OrgConnectorCatalogItem[]): void {
    const local = mcpServerService.list({}).items
    for (const server of local) {
      if (server.installSource !== 'manual' || server.tags?.includes('org')) continue
      const matched = catalog.some((item) => {
        if (server.name !== item.name || server.type !== item.type) return false
        if (item.type === 'stdio') {
          const expected = toCreateDto(item)
          return (
            server.command === expected.command &&
            JSON.stringify(server.args ?? []) === JSON.stringify(expected.args ?? [])
          )
        }
        return server.baseUrl === item.baseUrl
      })
      if (matched) mcpServerService.update(server.id, { tags: [...(server.tags ?? []), 'org'] })
    }
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
      const expected = toCreateDto(item)
      try {
        if (!state) {
          // [enterprise] C4 墓碑防复活：用户删除过的连接器（同 baseUrl）不自动重装；
          // 企业推送了新 baseUrl 视为重新下发，清墓碑正常安装。
          const tombstoneBaseUrl = orgStateStore.deletedConnectorBaseUrl(slug)
          if (tombstoneBaseUrl !== undefined) {
            if (tombstoneBaseUrl === item.baseUrl) {
              logger.info('compareAndSync skip tombstoned connector', { slug, baseUrl: item.baseUrl })
              continue
            }
            orgStateStore.clearConnectorDeleted(slug)
          }
          this.installLocal(item)
          orgStateStore.upsertConnector(slug, { mcpId: this.lastCreatedId, baseUrl: item.baseUrl })
          installed.push(slug)
        } else {
          // 期望配置 vs 本地实体逐字段比对：URL、command/args、headers、timeout 等任一变化都更新
          //（目录 v1 只比 baseUrl，会漏掉同 URL 的配置推送）。
          // isActive 属于本地用户状态（期望值恒 false 仅为新装默认），不参与 drift，避免同步把用户启用打回停用
          const current = mcpServerService.getByIdSafe(state.mcpId)
          if (!current) {
            // [enterprise] 本地行已不存在（用户手删但 state 未清）：沿用目录 v1 的 baseUrl 兜底语义
            if (state.baseUrl !== item.baseUrl) {
              mcpServerService.update(state.mcpId, { baseUrl: item.baseUrl })
              orgStateStore.upsertConnector(slug, { mcpId: state.mcpId, baseUrl: item.baseUrl })
              updated.push(slug)
            }
            continue
          }
          const drift = Object.entries(expected)
            .filter(([key]) => key !== 'isActive')
            .filter(([key, value]) => JSON.stringify(current[key as keyof typeof current]) !== JSON.stringify(value))
          if (drift.length > 0) {
            mcpServerService.update(state.mcpId, Object.fromEntries(drift) as Partial<CreateMcpServerDto>)
            orgStateStore.upsertConnector(slug, { mcpId: state.mcpId, baseUrl: item.baseUrl })
            updated.push(slug)
          }
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
          mcpServerService.update(state.mcpId, { isActive: false })
        } else if (!current) {
          // [enterprise] 本地已被用户手动删除 → 写墓碑（记删除时 baseUrl）+ 清 state 映射。
          // 此前只清映射，之后企业「下架 → 重新上架」会把连接器复活安装回来。
          orgStateStore.markConnectorDeleted(slug, state.baseUrl)
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

  /** [enterprise] 将旧托管连接器就地转成 manual；配置、启用状态和 Agent 关联不变。 */
  migrateLegacyCopies(): number {
    const legacy = mcpServerService.list({}).items.filter((server) => server.installSource === 'org')
    for (const server of legacy) mcpServerService.update(server.id, { installSource: 'manual' })
    return legacy.length
  }

  // [enterprise] installLocal 记录最近一次 create 的 id，供旧 compareAndSync 逻辑使用
  private lastCreatedId = ''

  // 停用原硬编码 sse 实现：目录 v2 config 携带完整客户端 MCP DTO。
  // private installLocal(item: OrgConnectorCatalogItem): void {
  //   const created = mcpServerService.create({
  //     name: item.name,
  //     description: item.description,
  //     type: 'sse',
  //     baseUrl: item.baseUrl,
  //     isActive: false, // 安装与启用分离：默认不启用，用户确认后手动开
  //     installSource: 'manual'
  //   })
  //   this.lastCreatedId = created.id
  //   logger.info('org connector installed as mcp server', { slug: item.slug, mcpId: created.id })
  // }
  private installLocal(item: OrgConnectorCatalogItem): void {
    const created = mcpServerService.create(toCreateDto(item))
    this.lastCreatedId = created.id
    logger.info('org connector installed as mcp server', { slug: item.slug, mcpId: created.id })
  }

  /** 安装连接器为企业 MCP 服务器（直连 SSE，本地直连使用，不经服务端代理） */
  async install(slug: string): Promise<void> {
    const catalog = await this.list()
    const item = catalog.find((c) => c.slug === slug)
    if (!item) throw new Error(`企业连接器不存在: ${slug}`)

    // [enterprise] copy 模式：安装后归用户本地所有，不再纳入组织同步与墓碑管理。
    // orgStateStore.clearConnectorDeleted(slug)
    this.installLocal(item)
    // orgStateStore.upsertConnector(slug, { mcpId: this.lastCreatedId, baseUrl: item.baseUrl })
  }
}
