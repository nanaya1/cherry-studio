import { eq } from 'drizzle-orm'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { assistantKnowledgeBaseTable, agentKnowledgeBaseTable } from '@data/db/schemas/assistantRelations'
import { assistantRemoteKnowledgeBaseTable, agentRemoteKnowledgeBaseTable } from '@data/db/schemas/remoteKnowledge'
import { isOrgId } from '@shared/data/types/enterpriseKnowledge'
import { isRemoteKnowledgeBaseId } from '@shared/data/types/remoteKnowledge'

export function captureKnowledgeSourceBindings(baseId: string): { assistantIds: string[]; agentIds: string[] } {
  return application.get('DbService').withWriteTx((tx) => ({
    assistantIds: tx
      .select()
      .from(assistantRemoteKnowledgeBaseTable)
      .where(eq(assistantRemoteKnowledgeBaseTable.remoteBaseId, baseId))
      .all()
      .map((row) => row.assistantId),
    agentIds: tx
      .select()
      .from(agentRemoteKnowledgeBaseTable)
      .where(eq(agentRemoteKnowledgeBaseTable.remoteBaseId, baseId))
      .all()
      .map((row) => row.agentId)
  }))
}

// MEA:enterprise-knowledge-page 删除云端后移除失效引用，不创建本机绑定。
export function removeKnowledgeSourceBindings(baseId: string): void {
  application.get('DbService').withWriteTx((tx) => {
    tx.delete(assistantRemoteKnowledgeBaseTable).where(eq(assistantRemoteKnowledgeBaseTable.remoteBaseId, baseId)).run()
    tx.delete(agentRemoteKnowledgeBaseTable).where(eq(agentRemoteKnowledgeBaseTable.remoteBaseId, baseId)).run()
  })
  notifyDataApiDataChange([
    { endpoint: '/assistants', kind: 'projection' },
    { endpoint: '/assistants/:id' },
    { endpoint: '/agents', kind: 'projection' },
    { endpoint: '/agents/:agentId' }
  ])
}

// MEA:enterprise-knowledge-page 在同一事务内迁移引用，云端 ID 不进入本地外键表。
export function replaceKnowledgeSourceBindings(from: string, to: string): void {
  if (from === to) return
  const remoteFrom = isOrgId(from) || isRemoteKnowledgeBaseId(from)
  const remoteTo = isOrgId(to) || isRemoteKnowledgeBaseId(to)
  application.get('DbService').withWriteTx((tx) => {
    const assistants = remoteFrom
      ? tx
          .select()
          .from(assistantRemoteKnowledgeBaseTable)
          .where(eq(assistantRemoteKnowledgeBaseTable.remoteBaseId, from))
          .all()
      : tx.select().from(assistantKnowledgeBaseTable).where(eq(assistantKnowledgeBaseTable.knowledgeBaseId, from)).all()
    const agents = remoteFrom
      ? tx
          .select()
          .from(agentRemoteKnowledgeBaseTable)
          .where(eq(agentRemoteKnowledgeBaseTable.remoteBaseId, from))
          .all()
      : tx.select().from(agentKnowledgeBaseTable).where(eq(agentKnowledgeBaseTable.knowledgeBaseId, from)).all()
    for (const { assistantId } of assistants) {
      if (remoteTo)
        tx.insert(assistantRemoteKnowledgeBaseTable)
          .values({ assistantId, remoteBaseId: to })
          .onConflictDoNothing()
          .run()
      else
        tx.insert(assistantKnowledgeBaseTable).values({ assistantId, knowledgeBaseId: to }).onConflictDoNothing().run()
    }
    for (const { agentId } of agents) {
      if (remoteTo)
        tx.insert(agentRemoteKnowledgeBaseTable).values({ agentId, remoteBaseId: to }).onConflictDoNothing().run()
      else tx.insert(agentKnowledgeBaseTable).values({ agentId, knowledgeBaseId: to }).onConflictDoNothing().run()
    }
    if (remoteFrom) {
      tx.delete(assistantRemoteKnowledgeBaseTable).where(eq(assistantRemoteKnowledgeBaseTable.remoteBaseId, from)).run()
      tx.delete(agentRemoteKnowledgeBaseTable).where(eq(agentRemoteKnowledgeBaseTable.remoteBaseId, from)).run()
    } else {
      tx.delete(assistantKnowledgeBaseTable).where(eq(assistantKnowledgeBaseTable.knowledgeBaseId, from)).run()
      tx.delete(agentKnowledgeBaseTable).where(eq(agentKnowledgeBaseTable.knowledgeBaseId, from)).run()
    }
  })
  notifyDataApiDataChange([
    { endpoint: '/assistants', kind: 'projection' },
    { endpoint: '/assistants/:id' },
    { endpoint: '/agents', kind: 'projection' },
    { endpoint: '/agents/:agentId' }
  ])
}
