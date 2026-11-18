import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { OrgApiHttpError } from '@main/enterprise/OrgApiClient'
import { OrgKnowledgeError } from '@main/enterprise/OrgKnowledgeService'
import { IpcApiService } from '@main/ipc/IpcApiService'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { enterpriseKnowledgeRequestSchemas } from '@shared/ipc/schemas/enterpriseKnowledge'
import { IpcChannel } from '@shared/IpcChannel'

import { enterpriseKnowledgeHandlers } from '../enterpriseKnowledge'

const ctx = { senderId: 'w1' }

describe('enterpriseKnowledgeHandlers', () => {
  const fakeKnowledge = {
    syncPreview: vi.fn(),
    syncApply: vi.fn(),
    syncStatus: vi.fn(),
    catalog: vi.fn(),
    listItems: vi.fn(),
    listDirectoryItems: vi.fn(),
    listChunks: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
    preview: vi.fn(),
    share: vi.fn(),
    shares: vi.fn(),
    unshare: vi.fn(),
    createShareCode: vi.fn(),
    revokeShare: vi.fn(),
    receiveShare: vi.fn(),
    members: vi.fn(),
    collaborators: vi.fn(),
    invite: vi.fn(),
    invitations: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    removeMember: vi.fn(),
    renameSharedBase: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'EnterprisePlugin' ? ({ knowledge: fakeKnowledge } as never) : (undefined as never)
    )
  })

  it('目录IPC接受界面的5/10/20/50/100页大小且省略时保留旧默认', async () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.items'].input
    for (const pageSize of [undefined, 5, 10, 20, 50, 100]) {
      const input = schema.parse({ baseId: 'orgkb:space', publicLibrary: true, pageSize })
      fakeKnowledge.listDirectoryItems.mockResolvedValue({ items: [], total: 0, nextCursor: null })
      await enterpriseKnowledgeHandlers['enterprise.knowledge.items'](input, ctx)
      expect(fakeKnowledge.listDirectoryItems).toHaveBeenLastCalledWith(
        'orgkb:space',
        null,
        null,
        true,
        pageSize,
        undefined
      )
    }
    for (const pageSize of [0, 21, 1000, 20.5, '20']) {
      expect(schema.safeParse({ baseId: 'orgkb:space', pageSize }).success).toBe(false)
    }
  })

  // MEA:public-knowledge-status-filter 覆盖首屏的 null 筛选，防止严格协议遗漏新字段。
  it('真实IPC入口接受全部状态和目录筛选，拒绝非法状态并保持管理默认', async () => {
    const service = new IpcApiService()
    ;(service as unknown as { onInit(): void }).onInit()
    const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IpcChannel.IpcApi_Request)![1]
    const event = {
      sender: { getType: () => 'window' },
      senderFrame: {
        url: pathToFileURL(resolve(application.getPath('app.root'), 'index.html')).href,
        parent: null
      }
    } as Parameters<typeof invoke>[0]
    vi.mocked(application.get).mockImplementation((name: string) => {
      if (name === 'EnterprisePlugin') return { knowledge: fakeKnowledge } as never
      if (name === 'WindowManager') return { getWindowIdByWebContents: () => 'w1' } as never
      return undefined as never
    })
    const page = { items: [], total: 0, nextCursor: null }
    fakeKnowledge.listDirectoryItems.mockResolvedValue(page)
    try {
      for (const pageSize of [5, 10, 20, 50, 100]) {
        for (const cursor of [null, '3']) {
          for (const parentId of [null, 'orgkb:folder']) {
            for (const statusFilter of [null, 'pending', 'parsing', 'parsed', 'indexing', 'ready', 'failed']) {
              const input = { baseId: 'orgkb:space', cursor, parentId, publicLibrary: true, pageSize, statusFilter }
              await expect(invoke(event, 'enterprise.knowledge.items', input)).resolves.toEqual({
                ok: true,
                data: page
              })
              expect(fakeKnowledge.listDirectoryItems).toHaveBeenLastCalledWith(
                'orgkb:space',
                cursor,
                parentId,
                true,
                pageSize,
                statusFilter ?? undefined
              )
            }
          }
        }
      }
      await expect(invoke(event, 'enterprise.knowledge.items', { baseId: 'orgkb:space' })).resolves.toEqual({
        ok: true,
        data: page
      })
      expect(fakeKnowledge.listDirectoryItems).toHaveBeenLastCalledWith(
        'orgkb:space',
        null,
        null,
        undefined,
        undefined,
        undefined
      )
      fakeKnowledge.listDirectoryItems.mockClear()
      for (const invalid of [
        { pageSize: '20' },
        { pageSize: 21 },
        { cursor: 3 },
        { publicLibrary: 'true' },
        { statusFilter: 'all' },
        { statusFilter: 'completed' },
        { statusFilter: 1 }
      ]) {
        await expect(
          invoke(event, 'enterprise.knowledge.items', { baseId: 'orgkb:space', ...invalid })
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'VALIDATION_FAILED', message: 'Invalid input for enterprise.knowledge.items' }
        })
      }
      expect(fakeKnowledge.listDirectoryItems).not.toHaveBeenCalled()
    } finally {
      await service._doDestroy()
    }
  })

  it('首传透传源文件选项，核对不覆盖持久模式', async () => {
    const result = { shareId: 'orgkb:copy', completion: 'incomplete', files: [] }
    fakeKnowledge.share.mockResolvedValue(result)
    expect(
      await enterpriseKnowledgeHandlers['enterprise.knowledge.share']({ baseId: 'local', uploadOriginal: false }, ctx)
    ).toEqual(result)
    expect(fakeKnowledge.share).toHaveBeenLastCalledWith('local', false, false)
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.upload_verify']({ baseId: 'local' }, ctx)).toEqual(
      result
    )
    expect(fakeKnowledge.share).toHaveBeenLastCalledWith('local', true)
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
    // fakeKnowledge.listItems.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_BAD_INPUT, 'bad id'))
    fakeKnowledge.listDirectoryItems.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_BAD_INPUT, 'bad id'))
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

  it('unshare delegates with local baseId and returns { ok }', async () => {
    fakeKnowledge.unshare.mockResolvedValue({ ok: true })
    expect(await enterpriseKnowledgeHandlers['enterprise.knowledge.unshare']({ baseId: 'local-uuid' }, ctx)).toEqual({
      ok: true
    })
    expect(fakeKnowledge.unshare).toHaveBeenCalledWith({ baseId: 'local-uuid' })
  })

  it('unshare maps OrgApiHttpError 404 to ORGKB_NOT_FOUND', async () => {
    fakeKnowledge.unshare.mockRejectedValue(new OrgApiHttpError(404, 'nf'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.unshare']({ baseId: 'local-uuid' }, ctx)
    ).rejects.toMatchObject({ code: E.ORGKB_NOT_FOUND })
  })

  it('rename_shared 委托服务并返回 void', async () => {
    fakeKnowledge.renameSharedBase.mockResolvedValue(undefined)
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.rename_shared']({ baseId: 'local-uuid', name: '新名' }, ctx)
    ).resolves.toBeUndefined()
    expect(fakeKnowledge.renameSharedBase).toHaveBeenCalledWith('local-uuid', '新名')
  })

  it('rename_shared 将 OrgKnowledgeError 映射为 IpcError', async () => {
    fakeKnowledge.renameSharedBase.mockRejectedValue(new OrgKnowledgeError(E.ORGKB_FORBIDDEN, 'owner required'))
    await expect(
      enterpriseKnowledgeHandlers['enterprise.knowledge.rename_shared']({ baseId: 'local-uuid', name: '新名' }, ctx)
    ).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
  })
})
