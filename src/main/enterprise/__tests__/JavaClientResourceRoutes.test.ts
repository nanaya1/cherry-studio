import { describe, expect, it, vi } from 'vitest'

import { JavaKnowledgeClient } from '../JavaKnowledgeClient'
import { JavaResourceClient } from '../JavaResourceClient'

const KNOWLEDGE_ID = '11111111-1111-1111-1111-111111111111'
const ITEM_ID = 'a'.repeat(32)
const BASE_URL = 'https://enterprise.test'

// 在权限拒绝时核对实际发出的请求，防止迁移遗漏或降级回到管理入口。
const knowledgeRoutes: [string, string, (client: JavaKnowledgeClient) => Promise<unknown>][] = [
  ['GET', 'page', (client) => client.getCatalog()],
  ['GET', 'detail', (client) => client.getSpace(KNOWLEDGE_ID)],
  ['GET', 'localShare/state', (client) => client.getLocalShareState(KNOWLEDGE_ID)],
  ['POST', 'localShare/finishRemoval', (client) => client.finishLocalShareRemoval(KNOWLEDGE_ID)],
  ['POST', 'localShare/add', (client) => client.createLocalShare('个人库', false)],
  ['POST', 'edit', (client) => client.renameSpace(KNOWLEDGE_ID, '新名称')],
  ['POST', 'remove', (client) => client.removeSpace(KNOWLEDGE_ID)],
  ['GET', 'file/page', (client) => client.listFiles(KNOWLEDGE_ID)],
  ['GET', 'file/detail', (client) => client.getFile(KNOWLEDGE_ID, ITEM_ID)],
  ['GET', 'file/chunks', (client) => client.listChunks(KNOWLEDGE_ID, ITEM_ID)],
  ['GET', 'file/content', (client) => client.read(KNOWLEDGE_ID, ITEM_ID)],
  ['GET', 'file/preview-url', (client) => client.getPreviewUrl(KNOWLEDGE_ID, ITEM_ID)],
  ['GET', 'file/preview', (client) => client.preview(KNOWLEDGE_ID, ITEM_ID)],
  ['GET', 'file/download', (client) => client.download(KNOWLEDGE_ID, ITEM_ID)],
  ['POST', 'folder/add', (client) => client.createFolder(KNOWLEDGE_ID, '目录')],
  ['POST', 'file/edit', (client) => client.renameFile(KNOWLEDGE_ID, ITEM_ID, '新名称')],
  ['POST', 'file/remove', (client) => client.removeFile(KNOWLEDGE_ID, ITEM_ID)],
  ['POST', 'search', (client) => client.search({ knowledgeIds: [KNOWLEDGE_ID], query: '检索词' })],
  ['GET', 'share/page', (client) => client.listShares(KNOWLEDGE_ID)],
  ['POST', 'share/add', (client) => client.createShare(KNOWLEDGE_ID, { expireDays: null })],
  ['POST', 'share/remove', (client) => client.revokeShare(KNOWLEDGE_ID, ITEM_ID)],
  ['POST', 'share/receive', (client) => client.receiveShare({ shareCode: 'sharecode1' })],
  ['GET', 'member/page', (client) => client.listMembers(KNOWLEDGE_ID)],
  ['GET', 'member/options', (client) => client.memberOptions({ knowledgeId: KNOWLEDGE_ID })],
  ['POST', 'member/add', (client) => client.addMember(KNOWLEDGE_ID, 42)],
  ['POST', 'member/remove', (client) => client.removeMember(KNOWLEDGE_ID, 42)],
  ['GET', 'invitation/page', (client) => client.listInvitations()],
  ['POST', 'invitation/accept', (client) => client.acceptInvitation(ITEM_ID)],
  ['POST', 'invitation/decline', (client) => client.declineInvitation(ITEM_ID)]
]

const resourceRoutes: [string, string, (client: JavaResourceClient) => Promise<unknown>][] = [
  ['GET', 'skill/page', (client) => client.listSkills()],
  ['GET', 'mcp/list', (client) => client.listConnectors()],
  ['GET', `file/view/${ITEM_ID}`, (client) => client.readFile(ITEM_ID)],
  [
    'POST',
    'skill/lifecycle/report',
    (client) =>
      client.reportLifecycle({ id: '1', eventId: ITEM_ID, event: 'install', version: '1', contentHash: 'a'.repeat(64) })
  ]
]

function transport() {
  return vi.fn<typeof fetch>(async () => Response.json({ code: 10007, data: null, requestId: 'route-denied' }))
}

function assertClientRequest(fetchImpl: ReturnType<typeof transport>, method: string, path: string) {
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [input, init] = fetchImpl.mock.calls[0]
  const url = new URL(String(input))
  expect(url.origin).toBe(BASE_URL)
  expect(url.pathname).toBe(`/api/v1/client/${path}`)
  expect(url.searchParams.has('scope')).toBe(false)
  expect(init?.method ?? 'GET').toBe(method)
  if (init?.body) expect(JSON.parse(String(init.body))).not.toHaveProperty('scope')
  const headers = new Headers(init?.headers)
  expect(headers.get('token')).toBe('raw-session')
  expect(headers.has('authorization')).toBe(false)
  expect(init?.credentials).toBe('omit')
  expect(init?.redirect).toBe('error')
}

describe('Java 客户端资源路由隔离', () => {
  it.each(knowledgeRoutes)('知识库 %s %s 省略 scope，拒绝后不回退', async (method, path, invoke) => {
    const fetchImpl = transport()
    const client = new JavaKnowledgeClient({
      baseUrl: BASE_URL,
      getAccessToken: async () => 'raw-session',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    await expect(invoke(client)).rejects.toThrow('无权限')
    assertClientRequest(fetchImpl, method, `knowledge/${path}`)
  })

  it.each(resourceRoutes)('资源 %s %s 省略 scope，拒绝后不回退', async (method, path, invoke) => {
    const fetchImpl = transport()
    const client = new JavaResourceClient({
      baseUrl: BASE_URL,
      getAccessToken: async () => 'raw-session',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    await expect(invoke(client)).rejects.toThrow('无权限')
    assertClientRequest(fetchImpl, method, path)
  })
})
