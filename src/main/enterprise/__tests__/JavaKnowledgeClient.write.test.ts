import { describe, expect, it, vi } from 'vitest'

import { JavaKnowledgeClient } from '../JavaKnowledgeClient'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
const FILE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const INV_A = 'cccccccccccccccccccccccccccccccc'

const envelope = (data: unknown, code = 200, requestId = 'req-kn') =>
  Response.json({ code, msg: '测试响应', data, requestId })

const space = (id: string) => ({
  id,
  tenantId: 9,
  name: '库',
  category: 'PUBLIC',
  spaceKind: 'local',
  creationOrigin: 'LOCAL_SHARE',
  canDownload: true
})

const file = (knowledgeId: string, fileId: string) => ({
  knowledgeId,
  fileId,
  name: 'a.txt',
  directory: false,
  mimeType: 'text/plain',
  fileSize: 10,
  parseStatus: 'ready'
})

const share = (knowledgeId: string, shareId: string) => ({
  shareId,
  knowledgeId,
  receivable: true
})

const member = (userId: number) => ({
  userId,
  role: 'viewer',
  status: 'active',
  expiresAt: null,
  activeTenantMember: true
})

const memberOption = (userId: number) => ({
  userId,
  username: 'u',
  showName: 'U'
})

const invitation = (knowledgeId: string, invitationId: string) => ({
  invitationId,
  knowledgeId,
  name: '库',
  inviterId: 7,
  inviterName: '邀请人',
  expiresAt: null
})

const operation = (id: number) => ({
  id,
  knowledgeId: UUID_A,
  creationOrigin: 'LOCAL_SHARE',
  publicState: 'NONE',
  operationState: 'READY'
})

function setup(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response)
  const onSessionExpired = vi.fn()
  const client = new JavaKnowledgeClient({
    baseUrl: 'https://ent.test',
    getAccessToken: async () => 'secret-token',
    fetchImpl,
    onSessionExpired
  })
  return { client, fetchImpl, onSessionExpired }
}

const bodyOf = (call: any) => JSON.parse(String(call[1]!.body))
const urlOf = (call: any) => String(call[0])

describe('JavaKnowledgeClient.createLocalShare', () => {
  it('POST /localShare/add 携带 camelCase 名称与开关，返回解析后的知识库', async () => {
    const { client, fetchImpl } = setup([envelope(space(UUID_A))])
    const result = await client.createLocalShare('我的库', true)
    expect(result.id).toBe(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/localShare/add')
    expect(call[1]!.method).toBe('POST')
    expect(bodyOf(call)).toMatchObject({ name: '我的库', allowLocalFileUpload: true })
  })

  it('空名称本地拒绝且不发请求', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.createLocalShare('   ', false)).rejects.toThrow('名称')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.removeSpace', () => {
  it('POST /remove 携带 scope=client 与 id，成功即返回', async () => {
    const { client, fetchImpl } = setup([envelope(null)])
    await client.removeSpace(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/remove')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A })
  })

  it('非法 id 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.removeSpace('bad')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.renameSpace', () => {
  it('POST /edit 携带 scope=client、id、name，并校验归属', async () => {
    const { client, fetchImpl } = setup([envelope(space(UUID_A))])
    const result = await client.renameSpace(UUID_A, '改名')
    expect(result.id).toBe(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/edit')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, name: '改名' })
  })

  it('归属不符 fail closed', async () => {
    const { client } = setup([envelope(space(UUID_B))])
    await expect(client.renameSpace(UUID_A, '改名')).rejects.toThrow('归属')
  })

  it('空名称本地拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.renameSpace(UUID_A, '')).rejects.toThrow('名称')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.createFolder', () => {
  it('POST /folder/add 携带 parentId 可选，校验知识库归属', async () => {
    const { client, fetchImpl } = setup([envelope(file(UUID_A, FILE_A))])
    const result = await client.createFolder(UUID_A, '目录', FILE_A)
    expect(result.knowledgeId).toBe(UUID_A)
    expect(result.fileId).toBe(FILE_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/folder/add')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, name: '目录', parentId: FILE_A })
  })

  it('省略 parentId 时不发送该字段', async () => {
    const { client, fetchImpl } = setup([envelope(file(UUID_A, FILE_A))])
    await client.createFolder(UUID_A, '根目录')
    expect(bodyOf(fetchImpl.mock.calls[0])).not.toHaveProperty('parentId')
  })

  it('非法 parentId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.createFolder(UUID_A, '目录', 'bad')).rejects.toThrow('父目录')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.removeFile', () => {
  it('POST /file/remove 携带 scope=client、id、fileId', async () => {
    const { client, fetchImpl } = setup([envelope(null)])
    await client.removeFile(UUID_A, FILE_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/file/remove')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, fileId: FILE_A })
  })

  it('非法 fileId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.removeFile(UUID_A, 'bad')).rejects.toThrow('文件ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.renameFile', () => {
  it('POST /file/edit 携带 scope=client、id、fileId、name，校验归属', async () => {
    const { client, fetchImpl } = setup([envelope(file(UUID_A, FILE_A))])
    const result = await client.renameFile(UUID_A, FILE_A, '新名')
    expect(result.knowledgeId).toBe(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/file/edit')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, fileId: FILE_A, name: '新名' })
  })

  it('归属不符 fail closed', async () => {
    const { client } = setup([envelope(file(UUID_B, FILE_A))])
    await expect(client.renameFile(UUID_A, FILE_A, '新名')).rejects.toThrow('归属')
  })
})

describe('JavaKnowledgeClient.createShare', () => {
  it('POST /share/add 携带可选参数与 expireDays，写返回必检 shareId', async () => {
    const { client, fetchImpl } = setup([envelope(share(UUID_A, FILE_A))])
    const result = await client.createShare(UUID_A, { password: 'abcd', maxViews: 5, expireDays: 30 })
    expect(result.shareId).toBe(FILE_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/share/add')
    expect(bodyOf(call)).toMatchObject({
      scope: 'client',
      id: UUID_A,
      password: 'abcd',
      maxViews: 5,
      expireDays: 30
    })
  })

  it('永久有效以 null 表达 expireDays', async () => {
    const { client, fetchImpl } = setup([envelope(share(UUID_A, FILE_A))])
    await client.createShare(UUID_A, { expireDays: null })
    expect(bodyOf(fetchImpl.mock.calls[0]).expireDays).toBeNull()
  })

  it('缺 shareId 的写响应 fail closed', async () => {
    const { client } = setup([envelope({ knowledgeId: UUID_A, receivable: true })])
    await expect(client.createShare(UUID_A, { expireDays: null })).rejects.toThrow('分享ID')
  })
})

describe('JavaKnowledgeClient.revokeShare', () => {
  it('POST /share/remove 携带 scope=client、id、shareId', async () => {
    const { client, fetchImpl } = setup([envelope(null)])
    await client.revokeShare(UUID_A, FILE_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/share/remove')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, shareId: FILE_A })
  })

  it('非法 shareId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.revokeShare(UUID_A, 'bad')).rejects.toThrow('分享ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.receiveShare', () => {
  it('POST /share/receive 携带 shareCode，返回解析后的知识库', async () => {
    const { client, fetchImpl } = setup([envelope(space(UUID_A))])
    const result = await client.receiveShare({ shareCode: 'abc-1234', password: 'pw' })
    expect(result.id).toBe(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/share/receive')
    expect(bodyOf(call)).toMatchObject({ shareCode: 'abc-1234', password: 'pw' })
  })

  it('非法 shareCode 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.receiveShare({ shareCode: '!!' })).rejects.toThrow('分享码')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.memberOptions', () => {
  it('GET /member/options 携带 knowledgeId 与关键字，返回分页原生 VO', async () => {
    const { client, fetchImpl } = setup([envelope({ items: [memberOption(42)], total: 1 })])
    const page = await client.memberOptions({ knowledgeId: UUID_A, keyword: 'bob', page: 1, pageSize: 20 })
    expect(page.items[0].userId).toBe(42)
    expect(page.total).toBe(1)
    const url = urlOf(fetchImpl.mock.calls[0])
    expect(url).toContain('/api/v1/knowledge/member/options?')
    expect(url).toContain(`knowledgeId=${UUID_A}`)
    expect(url).toContain('keyword=bob')
    expect(url).toContain('pageSize=20')
  })

  it('非法 knowledgeId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.memberOptions({ knowledgeId: 'bad' })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.addMember / removeMember', () => {
  it('addMember POST /member/add 携带 scope=client、id、userId、expireDays', async () => {
    const { client, fetchImpl } = setup([envelope(member(42))])
    const result = await client.addMember(UUID_A, 42, 7)
    expect(result.userId).toBe(42)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/member/add')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, userId: 42, expireDays: 7 })
  })

  it('removeMember POST /member/remove 携带 scope=client、id、userId', async () => {
    const { client, fetchImpl } = setup([envelope(null)])
    await client.removeMember(UUID_A, 42)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/member/remove')
    expect(bodyOf(call)).toMatchObject({ scope: 'client', id: UUID_A, userId: 42 })
  })

  it('非法 userId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.addMember(UUID_A, 0, 7)).rejects.toThrow('用户ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.listInvitations', () => {
  it('跨页取全量并解析邀请', async () => {
    const { client, fetchImpl } = setup([
      envelope({ items: [invitation(UUID_A, INV_A)], total: 150 }),
      envelope({ items: [invitation(UUID_B, FILE_A)], total: 150 })
    ])
    const items = await client.listInvitations()
    expect(items.map((item) => item.invitationId)).toEqual([INV_A, FILE_A])
    expect(fetchImpl.mock.calls).toHaveLength(2)
  })

  it('邀请 ID 必须为 32hex', async () => {
    const { client } = setup([envelope({ items: [{ invitationId: 'xx', knowledgeId: UUID_A }], total: 1 })])
    await expect(client.listInvitations()).rejects.toThrow()
  })
})

describe('JavaKnowledgeClient.acceptInvitation / declineInvitation', () => {
  it('acceptInvitation POST /invitation/accept 返回成员', async () => {
    const { client, fetchImpl } = setup([envelope(member(42))])
    const result = await client.acceptInvitation(INV_A)
    expect(result.userId).toBe(42)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/invitation/accept')
    expect(bodyOf(call)).toMatchObject({ invitationId: INV_A })
  })

  it('declineInvitation POST /invitation/decline 携带 invitationId', async () => {
    const { client, fetchImpl } = setup([envelope(null)])
    await client.declineInvitation(INV_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/invitation/decline')
    expect(bodyOf(call)).toMatchObject({ invitationId: INV_A })
  })

  it('非法 invitationId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.acceptInvitation('bad')).rejects.toThrow('邀请ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.listOperations', () => {
  it('GET /operation/page 返回分页操作', async () => {
    const { client, fetchImpl } = setup([envelope({ items: [operation(11)], total: 1 })])
    const page = await client.listOperations(1)
    expect(page.items[0].id).toBe(11)
    expect(urlOf(fetchImpl.mock.calls[0])).toContain('/api/v1/knowledge/operation/page?')
  })
})

describe('JavaKnowledgeClient.confirmOperation', () => {
  it('POST /operation/confirm 携带 id，返回空间', async () => {
    const { client, fetchImpl } = setup([envelope(space(UUID_A))])
    const result = await client.confirmOperation(11)
    expect(result?.id).toBe(UUID_A)
    const call = fetchImpl.mock.calls[0]
    expect(urlOf(call)).toBe('https://ent.test/api/v1/knowledge/operation/confirm')
    expect(bodyOf(call)).toMatchObject({ id: 11 })
  })

  it('删除确认返回 null', async () => {
    const { client } = setup([envelope(null)])
    expect(await client.confirmOperation(11)).toBeNull()
  })

  it('非法 operationId 发请求前拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.confirmOperation(0)).rejects.toThrow('操作ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient 写方法跨切面契约', () => {
  it('10008 触发会话失效', async () => {
    const { client, onSessionExpired } = setup([envelope(null, 10008)])
    await expect(client.removeSpace(UUID_A)).rejects.toThrow('重新登录')
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('业务失败(10007)抛错且不触发会话失效', async () => {
    const { client, onSessionExpired } = setup([envelope(null, 10007)])
    await expect(client.removeSpace(UUID_A)).rejects.toThrow('无权限')
    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('业务失败不重放：fetch 仅调用一次', async () => {
    const { client, fetchImpl } = setup([envelope(null, 10007)])
    await client.removeSpace(UUID_A).catch(() => {})
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('beforeSend 在 token 解析后、fetch 前执行（切号守卫），请求仍带 token', async () => {
    const events: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async () => envelope(space(UUID_A)))
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => {
        events.push('token')
        return 'secret-token'
      },
      fetchImpl,
      onSessionExpired: vi.fn()
    })
    const beforeSend = vi.fn(() => {
      events.push('guard')
    })
    await client.renameSpace(UUID_A, '改名', beforeSend)
    expect(beforeSend).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['token', 'guard'])
    expect(new Headers(fetchImpl.mock.calls[0][1]!.headers).get('token')).toBe('secret-token')
  })

  it('beforeSend 不随 ID 校验失败被调用', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      fetchImpl,
      onSessionExpired: vi.fn()
    })
    const beforeSend = vi.fn()
    await client.removeSpace('bad', beforeSend).catch(() => {})
    expect(beforeSend).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
