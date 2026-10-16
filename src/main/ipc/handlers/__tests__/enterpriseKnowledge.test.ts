import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { OrgApiHttpError } from '@main/enterprise/OrgApiClient'
import { OrgKnowledgeError } from '@main/enterprise/OrgKnowledgeService'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'
import { IpcError } from '@shared/ipc/errors/IpcError'

import { enterpriseKnowledgeHandlers } from '../enterpriseKnowledge'

const ctx = { senderId: 'w1' }

describe('enterpriseKnowledgeHandlers', () => {
  const fakeKnowledge = {
    syncPreview: vi.fn(),
    syncApply: vi.fn(),
    syncStatus: vi.fn(),
    catalog: vi.fn(),
    listItems: vi.fn(),
    listChunks: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
    preview: vi.fn(),
    share: vi.fn(),
    shares: vi.fn(),
    createShareCode: vi.fn(),
    revokeShare: vi.fn(),
    receiveShare: vi.fn(),
    members: vi.fn(),
    collaborators: vi.fn(),
    invite: vi.fn(),
    invitations: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    removeMember: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'EnterprisePlugin' ? ({ knowledge: fakeKnowledge } as never) : (undefined as never)
    )
  })

  it('同步三个签名返回稳定结果并映射权限错误', async () => {
    fakeKnowledge.syncStatus.mockResolvedValue({ state: 'unknown', lastSyncedAt: null })
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.sync_status']({ baseId: 'local' }, ctx)).toEqual({
      state: 'unknown',
      lastSyncedAt: null
    })
    const preview = { planId: 'p', baseId: 'local', shareId: 's', status: 'pending', changes: [], warnings: [] }
    fakeKnowledge.syncPreview.mockResolvedValue(preview)
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.sync_preview']({ baseId: 'local' }, ctx)).toEqual(
      preview
    )
    fakeKnowledge.syncApply.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_FORBIDDEN, 'owner required'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.sync_apply'](
        { baseId: 'local', planId: 'p', confirmDeletes: true },
        ctx
      )
    ).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
  })

  it('分享码四个签名返回服务结果并保留结果未知错误码', async () => {
    fakeKnowledge.shares.mockResolvedValue({ shares: [] })
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.shares']({ baseId: 'b' }, ctx)).toEqual({
      shares: []
    })
    fakeKnowledge.receiveShare.mockResolvedValue({ baseId: 'b', name: '名称' })
    expect(
      await enterpriseKnowledgeHandlers['enterprise.knowledge.receive_share']({ shareCode: 'AbCd_123' }, ctx)
    ).toEqual({ baseId: 'b', name: '名称' })
    fakeKnowledge.revokeShare.mockResolvedValue({ ok: true })
    expect(
      await enterpriseKnowledgeHandlers['enterprise.knowledge.revoke_share']({ baseId: 'b', shareId: 's' }, ctx)
    ).toEqual({ ok: true })
    fakeKnowledge.createShareCode.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_SHARE_CREATE_UNKNOWN, '刷新列表'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.create_share']({ baseId: 'b', expireDays: null }, ctx)
    ).rejects.toMatchObject({ code: E.ORGKB_SHARE_CREATE_UNKNOWN, message: '刷新列表' })
  })

  it('catalog delegates to the service and returns its result', async () => {
    fakeKnowledge.catalog.mockResolvedValue({ public: [], shared: [], owned: [] })
    const result = await enterpriseKnowledgeHandlers['enterprise.knowledge.catalog'](undefined, ctx)
    expect(fakeKnowledge.catalog).toHaveBeenCalled()
    expect(result).toEqual({ public: [], shared: [], owned: [] })
  })

  it('maps OrgKnowledgeError (BAD_INPUT) to IpcError', async () => {
    fakeKnowledge.listItems.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_BAD_INPUT, 'bad id'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.items']({ baseId: 'x' }, ctx)
    ).rejects.toBeInstanceOf(IpcError)
    await expect(enterpriseKnowledgeHandlers['enterprise.knowledge.items']({ baseId: 'x' }, ctx)).rejects.toMatchObject(
      {
        code: E.ORGKB_BAD_INPUT
      }
    )
  })

  it('maps OrgApiHttpError 404 to ORGKB_NOT_FOUND', async () => {
    fakeKnowledge.members.mockRejectedValue(new OrgApiHttpError(404, 'nf'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.members']({ baseId: 'x' }, ctx)
    ).rejects.toMatchObject({
      code: E.ORGKB_NOT_FOUND
    })
  })

  it('maps 未登录 to ORGKB_UNAUTHORIZED', async () => {
    fakeKnowledge.invitations.mockRejectedValue(new Error('未登录'))
    await expect(enterpriseKnowledgeHandlers['enterprise.knowledge.invitations'](undefined, ctx)).rejects.toMatchObject(
      {
        code: E.ORGKB_UNAUTHORIZED
      }
    )
  })

  it('collaborators delegates and returns service result', async () => {
    const result = { items: [{ id: 2, username: 'bob' }], total: 5, page: 1, pageSize: 20 }
    fakeKnowledge.collaborators.mockResolvedValue(result)
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.collaborators']({ keyword: 'bo' }, ctx)).toEqual(
      result
    )
    expect(fakeKnowledge.collaborators).toHaveBeenCalledWith({ keyword: 'bo' })
  })

  it('invite delegates with local baseId', async () => {
    const member = { userId: 3, username: 'carol', role: 'viewer', joinedAt: 't', status: 'active', expiresAt: null }
    fakeKnowledge.invite.mockResolvedValue(member)
    expect(
      await enterpriseKnowledgeHandlers['enterprise.knowledge.invite']({ baseId: 'local-uuid', userId: 3 }, ctx)
    ).toEqual(member)
    expect(fakeKnowledge.invite).toHaveBeenCalledWith({ baseId: 'local-uuid', userId: 3, expireDays: undefined })
  })
})
