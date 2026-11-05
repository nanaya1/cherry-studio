import type * as NodeFs from 'node:fs'
import { Readable } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { enterpriseKnowledgeErrorCodes as E } from '../../../shared/ipc/errors/enterpriseKnowledge'
import { JavaKnowledgeError } from '../JavaKnowledgeClient'
import { OrgKnowledgeError, OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

// --- 与 OrgKnowledgeService.javaRead.test.ts 一致的最小模块桩 ---
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof NodeFs>()),
  createReadStream: vi.fn(() => Readable.from([Buffer.from('file-bytes')]))
}))

vi.mock('../KnowledgeSourceBindings', () => ({
  replaceKnowledgeSourceBindings: vi.fn(),
  removeKnowledgeSourceBindings: vi.fn(),
  captureKnowledgeSourceBindings: vi.fn(() => ({ assistantIds: ['assistant'], agentIds: [] }))
}))

const { getSubtreeItems, recoveryItems } = vi.hoisted(() => ({
  getSubtreeItems: vi.fn((): unknown[] => []),
  recoveryItems: {
    getItemsByBaseId: vi.fn((): any[] => []),
    getById: vi.fn(),
    createActive: vi.fn(),
    updateStatus: vi.fn()
  }
}))
vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems, ...recoveryItems } }))

vi.mock('../OrgStateStore', () => ({
  OrgStateStore: class {},
  orgStateStore: {
    getFirstShareUpload: vi.fn().mockReturnValue(undefined),
    setFirstShareUpload: vi.fn(),
    getShareAssociation: vi.fn().mockReturnValue(undefined),
    getShareAssociations: vi.fn(() => ({})),
    setShareAssociation: vi.fn(),
    removeShareAssociation: vi.fn(),
    clearShare: vi.fn(),
    getCloudRecovery: vi.fn(),
    setCloudRecovery: vi.fn(),
    moveOwnedSpace: vi.fn(),
    getCloudRecoveries: vi.fn(() => ({})),
    getOwnedSpaceGroups: vi.fn(() => ({}))
  }
}))

const KID = '11111111-1111-4111-8111-111111111111'
const SID = '22222222222242228222222222222222'
const IID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OWNER = 7

const lease = { generation: 1, issuerId: 'server-1', groupId: 'g', userId: String(OWNER) }

function makeJavaKnowledge() {
  return {
    getCatalog: vi.fn(),
    listShares: vi.fn(),
    createShare: vi.fn(),
    revokeShare: vi.fn(),
    receiveShare: vi.fn(),
    listMembers: vi.fn(),
    memberOptions: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    listInvitations: vi.fn(),
    acceptInvitation: vi.fn(),
    declineInvitation: vi.fn(),
    getFile: vi.fn(),
    removeFile: vi.fn(),
    listChunks: vi.fn()
  }
}

function makeService(javaKnowledge: ReturnType<typeof makeJavaKnowledge>) {
  const apiClient = { javaKnowledge }
  const auth = {
    acquireLease: vi.fn(() => ({ ...lease })),
    assertLease: vi.fn(),
    apiClient
  }
  return { service: new OrgKnowledgeService(auth as never), auth }
}

describe('Java 删除文件安全边界', () => {
  const fileId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  let java: ReturnType<typeof makeJavaKnowledge>
  let built: ReturnType<typeof makeService>
  const remove = () => built.service.deleteFile({ baseId: encodeOrgId(KID), fileId: encodeOrgId(fileId) })

  beforeEach(() => {
    java = makeJavaKnowledge()
    built = makeService(java)
    java.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED' }])
    java.getFile.mockResolvedValue({ fileId, knowledgeId: KID })
    vi.mocked(orgStateStore.getCloudRecovery).mockReset()
    vi.mocked(orgStateStore.removeShareAssociation).mockClear()
    vi.mocked(orgStateStore.clearShare).mockClear()
  })

  it('确认归属后只通过 Java 删除一次', async () => {
    await expect(remove()).resolves.toEqual({ ok: true })
    expect(java.getFile).toHaveBeenCalledWith(KID, fileId)
    expect(java.removeFile).toHaveBeenCalledExactlyOnceWith(KID, fileId, expect.any(Function))
    expect(orgStateStore.removeShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
  })

  it.each([
    { fileId: SID, knowledgeId: KID },
    { fileId, knowledgeId: SID }
  ])('文件或空间归属不符时禁止删除 %j', async (file) => {
    java.getFile.mockResolvedValue(file)
    await expect(remove()).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
    expect(java.removeFile).not.toHaveBeenCalled()
  })

  it('非 owned 空间不读取或删除文件', async () => {
    java.getCatalog.mockResolvedValue([{ id: KID, category: 'SHARED' }])
    await expect(remove()).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
    expect(java.getFile).not.toHaveBeenCalled()
    expect(java.removeFile).not.toHaveBeenCalled()
  })

  it('恢复中的空间禁止删除', async () => {
    vi.mocked(orgStateStore.getCloudRecovery).mockReturnValue({ phase: 'restoring' } as never)
    await expect(remove()).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
    expect(java.removeFile).not.toHaveBeenCalled()
  })

  it.each([new JavaKnowledgeError(403, '无权限'), new Error('网络结果未知')])(
    '删除失败原样抛出，不重试或清理关联：%s',
    async (error) => {
      java.removeFile.mockRejectedValue(error)
      await expect(remove()).rejects.toBe(error)
      expect(java.removeFile).toHaveBeenCalledTimes(1)
      expect(orgStateStore.removeShareAssociation).not.toHaveBeenCalled()
      expect(orgStateStore.clearShare).not.toHaveBeenCalled()
    }
  )

  it('token 解析后切号由 beforeSend 阻止真实发送', async () => {
    const sent = vi.fn()
    java.removeFile.mockImplementation(async (_spaceId, _fileId, beforeSend) => {
      built.auth.assertLease.mockImplementation(() => {
        throw new Error('切号')
      })
      beforeSend()
      sent()
    })
    await expect(remove()).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(sent).not.toHaveBeenCalled()
    expect(java.removeFile).toHaveBeenCalledTimes(1)
    expect(built.auth.acquireLease).toHaveBeenCalledTimes(1)
  })

  it('读取文件期间切号后不得提交删除', async () => {
    java.getFile.mockImplementation(async () => {
      built.auth.assertLease.mockImplementation(() => {
        throw new Error('切号')
      })
      return { fileId, knowledgeId: KID }
    })
    await expect(remove()).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(java.removeFile).not.toHaveBeenCalled()
  })
})

describe('OrgKnowledgeService 写链路迁移：shares 走 Java', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
  })

  it('listShares 映射分享；不调用旧 client', async () => {
    javaKnowledge.listShares.mockResolvedValue([
      {
        knowledgeId: KID,
        receivable: false,
        shareId: SID,
        shareCode: 'ABC12345',
        hasPassword: false,
        maxViews: null,
        viewCount: 0,
        expiresAt: null,
        revokedAt: null,
        createTime: '2026-01-01T00:00:00+08:00'
      }
    ])
    const { shares } = await service.shares({ baseId: encodeOrgId(KID) })
    expect(javaKnowledge.listShares).toHaveBeenCalledWith(KID)
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({
      id: encodeOrgId(SID),
      spaceId: encodeOrgId(KID),
      shareCode: 'ABC12345',
      hasPassword: false,
      maxViews: null,
      viewCount: 0
    })
  })
})

describe('OrgKnowledgeService 写链路迁移：createShareCode 走 Java + owner 校验', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
    javaKnowledge.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: OWNER, name: 'k' } as never])
  })

  it('本人拥有的非公共库允许创建分享码', async () => {
    javaKnowledge.createShare.mockResolvedValue({
      knowledgeId: KID,
      receivable: false,
      shareId: SID,
      shareCode: 'XYZ98765',
      hasPassword: true,
      maxViews: 5,
      viewCount: 0,
      expiresAt: null,
      revokedAt: null,
      createTime: '2026-01-01T00:00:00+08:00'
    })
    const share = await service.createShareCode({
      baseId: encodeOrgId(KID),
      password: 'secret',
      maxViews: 5,
      expireDays: 7
    })
    expect(javaKnowledge.createShare).toHaveBeenCalledWith(
      KID,
      { password: 'secret', maxViews: 5, expireDays: 7 },
      expect.any(Function)
    )
    expect(share).toMatchObject({ spaceId: encodeOrgId(KID), shareCode: 'XYZ98765', hasPassword: true })
  })

  it('非本人拥有的库拒绝创建分享码', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: 999, name: 'k' } as never])
    await expect(service.createShareCode({ baseId: encodeOrgId(KID), expireDays: 7 })).rejects.toMatchObject({
      code: E.ORGKB_FORBIDDEN
    })
    expect(javaKnowledge.createShare).not.toHaveBeenCalled()
  })

  it('公共库拒绝创建分享码', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([{ id: KID, category: 'PUBLIC', ownerId: OWNER, name: 'k' } as never])
    await expect(service.createShareCode({ baseId: encodeOrgId(KID), expireDays: 7 })).rejects.toMatchObject({
      code: E.ORGKB_FORBIDDEN
    })
    expect(javaKnowledge.createShare).not.toHaveBeenCalled()
  })
})

describe('OrgKnowledgeService 写链路迁移：revoke / receive 走 Java', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
  })

  it('revokeShare 调用 Java revokeShare', async () => {
    javaKnowledge.revokeShare.mockResolvedValue(undefined)
    const result = await service.revokeShare({ baseId: encodeOrgId(KID), shareId: encodeOrgId(SID) })
    expect(javaKnowledge.revokeShare).toHaveBeenCalledWith(KID, SID, expect.any(Function))
    expect(result).toEqual({ ok: true })
  })

  it('receiveShare 映射 baseId/name', async () => {
    javaKnowledge.receiveShare.mockResolvedValue({ id: KID, name: 'received' })
    const result = await service.receiveShare({ shareCode: 'ABC12345', password: 'secret' })
    expect(javaKnowledge.receiveShare).toHaveBeenCalledWith(
      { shareCode: 'ABC12345', password: 'secret' },
      expect.any(Function)
    )
    expect(result).toEqual({ baseId: encodeOrgId(KID), name: 'received' })
  })
})

describe('OrgKnowledgeService 写链路迁移：members / invite / removeMember 走 Java', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
    javaKnowledge.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: OWNER, name: 'k' } as never])
  })

  it('members 走 Java listMembers', async () => {
    javaKnowledge.listMembers.mockResolvedValue([
      { userId: 10, role: 'viewer', status: 'active', expiresAt: null, activeTenantMember: true, showName: 'u10' }
    ])
    const { members } = await service.members({ baseId: encodeOrgId(KID) })
    expect(javaKnowledge.listMembers).toHaveBeenCalledWith(KID)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ userId: 10, role: 'viewer', status: 'active' })
  })

  it('invite 校验 owner 后调用 Java addMember', async () => {
    javaKnowledge.listMembers.mockResolvedValue([])
    javaKnowledge.addMember.mockResolvedValue({
      userId: 20,
      role: 'viewer',
      status: 'pending',
      expiresAt: null,
      activeTenantMember: true,
      showName: 'u20'
    })
    const member = await service.invite({ baseId: encodeOrgId(KID), userId: 20, expireDays: 3 })
    expect(javaKnowledge.addMember).toHaveBeenCalledWith(KID, 20, 3, expect.any(Function))
    expect(member).toMatchObject({ userId: 20, role: 'viewer' })
  })

  it('invite 重复生效成员被拒', async () => {
    javaKnowledge.listMembers.mockResolvedValue([
      { userId: 20, role: 'viewer', status: 'active', expiresAt: null, activeTenantMember: true, showName: 'u20' }
    ])
    await expect(service.invite({ baseId: encodeOrgId(KID), userId: 20 })).rejects.toMatchObject({
      code: E.ORGKB_MEMBER_EXISTS
    })
    expect(javaKnowledge.addMember).not.toHaveBeenCalled()
  })

  it('removeMember 走 Java removeMember', async () => {
    javaKnowledge.removeMember.mockResolvedValue(undefined)
    const result = await service.removeMember({ baseId: encodeOrgId(KID), userId: 30 })
    expect(javaKnowledge.removeMember).toHaveBeenCalledWith(KID, 30, expect.any(Function))
    expect(result).toEqual({ ok: true })
  })
})

describe('OrgKnowledgeService 写链路迁移：invitations / accept / decline 走 Java', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
  })

  it('invitations 走 Java listInvitations', async () => {
    javaKnowledge.listInvitations.mockResolvedValue([
      {
        invitationId: IID,
        knowledgeId: KID,
        name: 'inv',
        inviterId: 1,
        inviterName: 'owner',
        expiresAt: '2026-01-02T00:00:00+08:00'
      }
    ])
    const { invitations } = await service.invitations()
    expect(javaKnowledge.listInvitations).toHaveBeenCalled()
    expect(invitations).toHaveLength(1)
    expect(invitations[0]).toMatchObject({
      id: encodeOrgId(IID),
      spaceId: encodeOrgId(KID),
      name: 'inv',
      inviter: '1'
    })
  })

  it('accept 走 Java acceptInvitation', async () => {
    javaKnowledge.acceptInvitation.mockResolvedValue({
      userId: 40,
      role: 'viewer',
      status: 'active',
      expiresAt: null,
      activeTenantMember: true,
      showName: 'u40'
    })
    const member = await service.accept({ invitationId: encodeOrgId(IID) })
    expect(javaKnowledge.acceptInvitation).toHaveBeenCalledWith(IID, expect.any(Function))
    expect(member).toMatchObject({ userId: 40, role: 'viewer' })
  })

  it('decline 走 Java declineInvitation', async () => {
    javaKnowledge.declineInvitation.mockResolvedValue(undefined)
    const result = await service.decline({ invitationId: encodeOrgId(IID) })
    expect(javaKnowledge.declineInvitation).toHaveBeenCalledWith(IID, expect.any(Function))
    expect(result).toEqual({ ok: true })
  })
})

describe('分享成员安全边界', () => {
  beforeEach(() => {
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({})
    vi.mocked(orgStateStore.getCloudRecovery).mockReturnValue(undefined)
  })

  it('创建分享的 Java 明确业务拒绝原样抛出，不标记为未知或重试', async () => {
    const java = makeJavaKnowledge()
    const { service } = makeService(java)
    java.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: OWNER }])
    const error = new JavaKnowledgeError(403, '无分享权限')
    java.createShare.mockRejectedValue(error)
    await expect(service.createShareCode({ baseId: encodeOrgId(KID), expireDays: null })).rejects.toBe(error)
    expect(java.createShare).toHaveBeenCalledTimes(1)
  })

  it('创建分享前的状态变化不应误报远端结果未知', async () => {
    const java = makeJavaKnowledge()
    const { service } = makeService(java)
    java.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: OWNER }])
    vi.mocked(orgStateStore.getCloudRecovery)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ phase: 'restoring' } as never)
    await expect(service.createShareCode({ baseId: encodeOrgId(KID), expireDays: null })).rejects.toMatchObject({
      code: E.ORGKB_SHARE_FAILED
    })
    expect(java.createShare).not.toHaveBeenCalled()
  })

  it('创建分享网络结果未知只发送一次，且不删除本地记录', async () => {
    const java = makeJavaKnowledge()
    const { service } = makeService(java)
    java.getCatalog.mockResolvedValue([{ id: KID, category: 'OWNED', ownerId: OWNER }])
    java.createShare.mockRejectedValue(new Error('网络连接中断'))
    await expect(service.createShareCode({ baseId: encodeOrgId(KID), expireDays: null })).rejects.toMatchObject({
      code: E.ORGKB_SHARE_CREATE_UNKNOWN
    })
    expect(java.createShare).toHaveBeenCalledTimes(1)
    expect(orgStateStore.removeShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
  })

  it('缺失分享身份时拒绝映射，不用空字符串伪造 ID', async () => {
    const java = makeJavaKnowledge()
    const { service } = makeService(java)
    java.listShares.mockResolvedValue([{ knowledgeId: KID, receivable: false }])
    await expect(service.shares({ baseId: encodeOrgId(KID) })).rejects.toMatchObject({ code: E.ORGKB_PROTOCOL })
  })

  it.each(['revoke', 'receive', 'accept', 'decline', 'remove'] as const)(
    '%s 在 token 解析后用同一租约阻断切号发送',
    async (operation) => {
      const java = makeJavaKnowledge()
      const { service, auth } = makeService(java)
      const error = new OrgKnowledgeError(E.ORGKB_FORBIDDEN, '账号已变化')
      const beforeSend = async (...args: unknown[]) => {
        auth.assertLease.mockImplementation(() => {
          throw error
        })
        ;(args.at(-1) as () => void)()
      }
      java.revokeShare.mockImplementation(beforeSend)
      java.receiveShare.mockImplementation(beforeSend)
      java.acceptInvitation.mockImplementation(beforeSend)
      java.declineInvitation.mockImplementation(beforeSend)
      java.removeMember.mockImplementation(beforeSend)
      const calls = {
        revoke: () => service.revokeShare({ baseId: encodeOrgId(KID), shareId: encodeOrgId(SID) }),
        receive: () => service.receiveShare({ shareCode: 'ABC12345' }),
        accept: () => service.accept({ invitationId: encodeOrgId(IID) }),
        decline: () => service.decline({ invitationId: encodeOrgId(IID) }),
        remove: () => service.removeMember({ baseId: encodeOrgId(KID), userId: 20 })
      }
      await expect(calls[operation]()).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
      expect(auth.acquireLease).toHaveBeenCalledTimes(1)
    }
  )
})

describe('OrgKnowledgeService 写链路迁移：collaborators 需 baseId 走 Java memberOptions', () => {
  const javaKnowledge = makeJavaKnowledge()
  let service: OrgKnowledgeService

  beforeEach(() => {
    for (const fn of Object.values(javaKnowledge)) fn.mockReset()
    const built = makeService(javaKnowledge)
    service = built.service
  })

  it('携带 knowledgeId 查询并过滤本人', async () => {
    javaKnowledge.memberOptions.mockResolvedValue({
      items: [
        { userId: OWNER, username: 'me', showName: 'me' },
        { userId: 50, username: 'u50', showName: 'U50' }
      ],
      total: 2,
      page: 1,
      pageSize: 100
    })
    const result = await service.collaborators({ baseId: encodeOrgId(KID), keyword: 'u', page: 1, pageSize: 100 })
    expect(javaKnowledge.memberOptions).toHaveBeenCalledWith(
      { knowledgeId: KID, keyword: 'u', page: 1, pageSize: 100 },
      expect.any(Function)
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: 50, username: 'u50' })
    expect(result.total).toBe(2)
  })
})
