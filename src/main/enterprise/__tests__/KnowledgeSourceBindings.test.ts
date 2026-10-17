import { setupTestDatabase } from '@test-helpers/db'
import { MockMainDbServiceExport } from '@test-mocks/main/DbService'
import { beforeEach, expect, it, vi } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import { assistantKnowledgeBaseTable, agentKnowledgeBaseTable } from '@data/db/schemas/assistantRelations'
import { knowledgeBaseTable } from '@data/db/schemas/knowledge'
import { assistantRemoteKnowledgeBaseTable, agentRemoteKnowledgeBaseTable } from '@data/db/schemas/remoteKnowledge'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { encodeOrgId } from '@shared/data/types/enterpriseKnowledge'

import {
  captureKnowledgeSourceBindings,
  removeKnowledgeSourceBindings,
  replaceKnowledgeSourceBindings
} from '../KnowledgeSourceBindings'

vi.mock('@data/dataApiDataChange', () => ({ notifyDataApiDataChange: vi.fn() }))
const dbh = setupTestDatabase()
beforeEach(() => {
  MockMainDbServiceExport.dbService.withWriteTx.mockImplementation((fn) => dbh.db.transaction(fn))
})
it('分享和取消在真实外键约束下迁移助手与智能体引用，保留已有绑定且幂等', () => {
  dbh.db
    .insert(knowledgeBaseTable)
    .values([
      { id: 'local', name: '本机', status: 'completed', chunkSize: 1000, chunkOverlap: 100 },
      { id: 'restored', name: '恢复', status: 'completed', chunkSize: 1000, chunkOverlap: 100 }
    ])
    .run()
  dbh.db
    .insert(assistantTable)
    .values({ id: 'assistant', name: '助手', orderKey: 'a', emoji: '', settings: DEFAULT_ASSISTANT_SETTINGS })
    .run()
  dbh.db
    .insert(agentTable)
    .values({ id: 'agent', name: '智能体', type: 'custom', instructions: '', orderKey: 'a' })
    .run()
  dbh.db.insert(assistantKnowledgeBaseTable).values({ assistantId: 'assistant', knowledgeBaseId: 'local' }).run()
  dbh.db.insert(agentKnowledgeBaseTable).values({ agentId: 'agent', knowledgeBaseId: 'local' }).run()
  const cloud = encodeOrgId('space')
  replaceKnowledgeSourceBindings('local', cloud)
  replaceKnowledgeSourceBindings('local', cloud)
  expect(dbh.db.select().from(assistantKnowledgeBaseTable).all()).toHaveLength(0)
  expect(dbh.db.select().from(agentKnowledgeBaseTable).all()).toHaveLength(0)
  expect(dbh.db.select().from(assistantRemoteKnowledgeBaseTable).all()[0].remoteBaseId).toBe(cloud)
  expect(dbh.db.select().from(agentRemoteKnowledgeBaseTable).all()[0].remoteBaseId).toBe(cloud)
  replaceKnowledgeSourceBindings(cloud, 'restored')
  expect(dbh.db.select().from(assistantKnowledgeBaseTable).all()[0].knowledgeBaseId).toBe('restored')
  expect(dbh.db.select().from(agentKnowledgeBaseTable).all()[0].knowledgeBaseId).toBe('restored')
  expect(dbh.db.select().from(assistantRemoteKnowledgeBaseTable).all()).toHaveLength(0)
  expect(dbh.db.select().from(agentRemoteKnowledgeBaseTable).all()).toHaveLength(0)
  replaceKnowledgeSourceBindings('restored', cloud)
  dbh.db
    .insert(assistantRemoteKnowledgeBaseTable)
    .values({ assistantId: 'assistant', remoteBaseId: encodeOrgId('other') })
    .run()
  expect(captureKnowledgeSourceBindings(cloud)).toEqual({ assistantIds: ['assistant'], agentIds: ['agent'] })
  removeKnowledgeSourceBindings(cloud)
  removeKnowledgeSourceBindings(cloud)
  expect(
    dbh.db
      .select()
      .from(assistantRemoteKnowledgeBaseTable)
      .all()
      .map((row) => row.remoteBaseId)
  ).toEqual([encodeOrgId('other')])
  expect(dbh.db.select().from(agentRemoteKnowledgeBaseTable).all()).toHaveLength(0)
  expect(dbh.db.select().from(assistantKnowledgeBaseTable).all()).toHaveLength(0)
  expect(dbh.db.select().from(knowledgeBaseTable).all()).toHaveLength(2)
})
