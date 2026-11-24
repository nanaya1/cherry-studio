import { application } from '@application'
import { mcpServerService } from '@data/services/McpServerService'
import { profileSwitchFence } from '@main/core/profiles'
import type { ExternalKnowledgeConnectorItem } from '@shared/ipc/schemas/enterprise'
import { externalKnowledgeReference, parseExternalKnowledgeReference } from '@shared/utils/externalKnowledgeConnector'

import {
  JavaKnowledgeConnectorClient,
  JavaKnowledgeConnectorError,
  type JavaKnowledgeConnector
} from './JavaKnowledgeConnectorClient'
import type { OrgAuthManager } from './OrgAuthManager'

/** MEA:external-knowledge-connectors 仅目录点击更新，不接入在线授权轮询或运行时成员验权 */
export class ExternalKnowledgeConnectorCatalog {
  private readonly desired = new Map<string, JavaKnowledgeConnector>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly auth: OrgAuthManager) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  list(): Promise<ExternalKnowledgeConnectorItem[]> {
    return this.serialize(async () => {
      const session = await this.auth.getValidSession()
      if (!session || session.authMode !== 'management-java') throw new Error('请先登录企业账号')
      const lease = this.auth.acquireLease()
      let snapshot
      try {
        snapshot = await new JavaKnowledgeConnectorClient(session.authOrigin, session.accessToken).list()
      } catch (error) {
        this.auth.assertLease(lease)
        if (error instanceof JavaKnowledgeConnectorError && [10007, 10008].includes(error.code)) {
          await this.disableScope(lease)
        }
        throw error
      }
      this.auth.assertLease(lease)
      if (snapshot.userId !== lease.userId || snapshot.tenantId !== lease.tenantId)
        throw new Error('企业上下文已变化，请重新进入外部知识库')
      profileSwitchFence.assertWritable()
      const incoming = new Map<string, JavaKnowledgeConnector>(
        snapshot.items.map((item) => [
          externalKnowledgeReference({
            issuerId: lease.issuerId,
            userId: lease.userId,
            tenantId: snapshot.tenantId,
            instanceId: item.id
          }),
          item
        ])
      )
      const stopIds: string[] = []
      // 只有完整成功快照才能停用缺失项；保留用户的关闭状态，不按名称认领已有MCP
      application.get('DbService').withWriteTx(() => {
        for (const server of mcpServerService.list({}).items) {
          const source = parseExternalKnowledgeReference(server.reference)
          if (!source || source.issuerId !== lease.issuerId || source.userId !== lease.userId) continue
          const item = incoming.get(server.reference!)
          if (!item) {
            mcpServerService.update(server.id, { isActive: false, headers: {} })
            stopIds.push(server.id)
            continue
          }
          if (server.baseUrl !== item.baseUrl || server.headers?.['mcp-key'] !== item.headers['mcp-key'])
            stopIds.push(server.id)
          mcpServerService.update(server.id, {
            name: this.serverName(item),
            description: item.description,
            type: item.type,
            baseUrl: item.baseUrl,
            headers: item.headers
          })
        }
      })
      this.desired.clear()
      for (const [key, item] of incoming) this.desired.set(key, item)
      await this.stopServers(stopIds, lease)
      this.auth.assertLease(lease)
      return [...incoming].map(([key, item]) => this.view(key, item))
    })
  }

  setActive(resourceKey: string, active: boolean): Promise<ExternalKnowledgeConnectorItem> {
    return this.serialize(async () => {
      const lease = this.auth.acquireLease()
      const source = parseExternalKnowledgeReference(resourceKey)
      const item = this.desired.get(resourceKey)
      if (
        !source ||
        !item ||
        source.issuerId !== lease.issuerId ||
        source.userId !== lease.userId ||
        source.tenantId !== lease.tenantId
      ) {
        throw new Error('请重新进入外部知识库后操作')
      }
      profileSwitchFence.assertWritable()
      let server = this.local(resourceKey)
      if (!server) {
        server = mcpServerService.create({
          name: this.serverName(item),
          description: item.description,
          type: item.type,
          baseUrl: item.baseUrl,
          headers: item.headers,
          reference: resourceKey,
          installSource: 'manual',
          isActive: false,
          isTrusted: false
        })
      }
      const serverId = server.id
      mcpServerService.update(serverId, { isActive: active })
      try {
        if (active) await application.get('McpRuntimeService').restartServer(serverId)
        else await application.get('McpRuntimeService').stopServer(serverId)
        this.auth.assertLease(lease)
      } catch {
        // 启动失败回到关闭态，禁止把连接失败展示为已启动
        this.auth.assertLease(lease)
        profileSwitchFence.assertWritable()
        mcpServerService.update(serverId, { isActive: false })
        await this.stopServers([serverId], lease)
        throw new Error('外部知识库连接操作失败，请检查服务状态后重试')
      }
      return this.view(resourceKey, item)
    })
  }

  private async disableScope(lease: ReturnType<OrgAuthManager['acquireLease']>): Promise<void> {
    profileSwitchFence.assertWritable()
    const ids = mcpServerService
      .list({})
      .items.filter((server) => {
        const source = parseExternalKnowledgeReference(server.reference)
        return (
          source?.issuerId === lease.issuerId && source.userId === lease.userId && source.tenantId === lease.tenantId
        )
      })
      .map((server) => server.id)
    application.get('DbService').withWriteTx(() => {
      for (const id of ids) mcpServerService.update(id, { isActive: false, headers: {} })
    })
    this.desired.clear()
    await this.stopServers(ids, lease)
  }

  private async stopServers(ids: string[], lease: ReturnType<OrgAuthManager['acquireLease']>): Promise<void> {
    let failed = false
    for (const id of ids) {
      this.auth.assertLease(lease)
      try {
        await application.get('McpRuntimeService').stopServer(id)
      } catch {
        // 一项断开失败仍尝试其余项，运行时异常原文不跨IPC暴露
        failed = true
      }
    }
    if (failed) throw new Error('外部知识库连接停止失败，请重试')
  }

  private local(resourceKey: string) {
    return mcpServerService.list({}).items.find((server) => server.reference === resourceKey)
  }

  private serverName(item: JavaKnowledgeConnector): string {
    return `${item.name} (${item.id})`
  }

  private view(resourceKey: string, item: JavaKnowledgeConnector): ExternalKnowledgeConnectorItem {
    const local = this.local(resourceKey)
    return {
      resourceKey,
      id: item.id,
      name: item.name,
      description: item.description,
      kind: item.kind,
      serverId: local?.id ?? null,
      isActive: local?.isActive ?? false
    }
  }
}
