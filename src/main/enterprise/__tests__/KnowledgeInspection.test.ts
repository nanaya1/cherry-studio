import { afterEach, describe, expect, it, vi } from 'vitest'

import { encodeOrgId } from '@shared/data/types/enterpriseKnowledge'

import { KnowledgeInspection } from '../KnowledgeInspection'
import { KnowledgeInspectionClient } from '../KnowledgeInspectionClient'
import { OrgApiClient } from '../OrgApiClient'
import type { OrgAuthManager } from '../OrgAuthManager'
import type { OrgSession } from '../types'

const baseId = '11111111-1111-1111-1111-111111111111'
const fileId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const page = (items: unknown[], total = items.length) => ({
  items,
  total,
  current: 1,
  size: 20,
  pages: Math.ceil(total / 20),
  columns: null
})
afterEach(() => vi.unstubAllGlobals())
function setup(data: unknown, code = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code, data }))
  const expired = vi.fn()
  return {
    client: new KnowledgeInspectionClient({
      baseUrl: 'https://enterprise.test',
      getAccessToken: async () => 'token-secret',
      onSessionExpired: expired,
      fetchImpl
    }),
    fetchImpl,
    expired
  }
}

describe('管理查看 HTTP 契约', () => {
  it('通过专用路径获取转换预览且舍弃原件地址', async () => {
    const { client, fetchImpl } = setup({
      fileName: '报告.docx',
      minioPreviewUrl: 'https://storage.test/preview.pdf?signature=test',
      url: 'https://storage.test/original.docx'
    })
    await expect(client.previewUrl(baseId, fileId, () => {})).resolves.toEqual({
      fileName: '报告.docx',
      minioPreviewUrl: 'https://storage.test/preview.pdf?signature=test'
    })
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/api/v1/client/knowledge/inspection/file/preview-url')
    expect(Object.fromEntries(url.searchParams)).toEqual({ id: baseId, fileId })
  })
  // 防止迟到的失效响应清除新企业会话，或误用切换后的凭据请求旧企业。
  it('使用原会话凭据，切换后拒绝迟到的登录失效回调', async () => {
    const session: OrgSession = {
      authMode: 'management-java',
      accountKind: 'management',
      issuerId: 'server-a',
      authOrigin: 'https://enterprise.test',
      userId: '41',
      tenantId: '1',
      groupId: null,
      role: 'OWNER',
      displayName: null,
      phone: '',
      officialUserId: '',
      accessToken: 'old-token',
      expiresAt: null
    }
    const expired = vi.fn()
    const current = vi.fn(async () => ({ ...session, tenantId: '2', accessToken: 'new-token' }))
    const api = new OrgApiClient(current, undefined, expired)
    let resolve!: (response: Response) => void
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
    vi.stubGlobal('fetch', fetchImpl)
    let active = true
    const guard = () => {
      if (!active) throw new Error('stale')
    }
    const request = api.knowledgeInspection(session, guard).spaces({ page: 1 }, guard)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('token')).toBe('old-token')
    active = false
    resolve(Response.json({ code: 10008 }))
    await expect(request).rejects.toThrow('stale')
    expect(expired).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
  })
  it('解析 Java 分页并编码 ID，仅保留只读展示字段', async () => {
    const { client, fetchImpl } = setup(
      page(
        [
          {
            id: baseId,
            name: '共享库',
            inspectionView: true,
            editable: false,
            manageable: false,
            canDownload: false,
            qaAuthorized: false,
            shareCode: 'secret',
            ownerId: 0
          }
        ],
        23
      )
    )
    const result = await client.spaces({ page: 1, keyword: '测试' }, () => {})
    expect(result).toMatchObject({
      total: 23,
      page: 1,
      pageSize: 20,
      items: [{ id: encodeOrgId(baseId), ownerId: null, qaAuthorized: false }]
    })
    expect(result.items[0]).not.toHaveProperty('shareCode')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain('/api/v1/client/knowledge/inspection/page?')
    expect(new URL(String(url)).searchParams.get('keyword')).toBe('测试')
    expect(new Headers(init?.headers).get('token')).toBe('token-secret')
    expect(init?.method).toBeUndefined()
    expect(init?.redirect).toBe('error')
  })
  it('拒绝写能力被错误打开的响应，文件和正文拒绝跨空间归属', async () => {
    const invalid = setup(
      page([
        {
          id: baseId,
          name: '库',
          inspectionView: true,
          editable: true,
          manageable: false,
          canDownload: false,
          qaAuthorized: true
        }
      ])
    )
    await expect(invalid.client.spaces({ page: 1 }, () => {})).rejects.toThrow()
    const files = setup(
      page([{ knowledgeId: '22222222-2222-2222-2222-222222222222', fileId, name: '越权', directory: false }])
    )
    await expect(files.client.files(baseId, 1, undefined, () => {})).rejects.toThrow()
    const content = setup({
      knowledgeId: baseId,
      fileId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      content: '越权',
      totalChars: 2,
      truncated: false
    })
    await expect(content.client.content(baseId, fileId, () => {})).rejects.toThrow()
  })
  it('关系数据不返回分享码、密码和链接，业务失败不能变成空列表', async () => {
    const { client } = setup(
      page([
        {
          id: fileId,
          status: 'exhausted',
          receiptCount: 1,
          shareCode: 'secret',
          passwordHash: 'private',
          url: 'https://private.test'
        }
      ])
    )
    const result = await client.relations('share/page', baseId, 1, undefined, () => {})
    expect(result.items[0]).toMatchObject({
      id: encodeOrgId(fileId),
      receiptCount: 1,
      status: 'exhausted',
      sharerId: null
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|private/)
    const failed = setup(null, 10007)
    await expect(failed.client.spaces({ page: 1 }, () => {})).rejects.toMatchObject({ code: 10007 })
  })
})

describe('管理查看主进程守卫', () => {
  function auth(role = 'OWNER') {
    const session = { authMode: 'management-java', role, tenantId: '1', userId: '41' }
    const client = { spaces: vi.fn().mockResolvedValue(page([])) }
    const manager = {
      acquireLease: vi.fn().mockReturnValue({ generation: 1 }),
      assertLease: vi.fn(),
      retryVerification: vi.fn().mockResolvedValue(undefined),
      getValidSession: vi.fn().mockResolvedValue(session),
      apiClient: { knowledgeInspection: vi.fn().mockReturnValue(client) }
    }
    return { manager, client, session, inspection: new KnowledgeInspection(manager as unknown as OrgAuthManager) }
  }
  it.each(['MEMBER', 'PLATFORM'])('拒绝 %s，平台身份不豁免企业角色', async (role) => {
    const { inspection, manager } = auth(role)
    await expect(inspection.spaces({ page: 1 })).rejects.toMatchObject({ code: 'ORGKB_FORBIDDEN' })
    expect(manager.apiClient.knowledgeInspection).not.toHaveBeenCalled()
  })
  it('没有可用会话时返回明确的登录失效错误', async () => {
    const { inspection, manager } = auth()
    manager.acquireLease.mockImplementation(() => {
      throw new Error('unavailable')
    })
    await expect(inspection.spaces({ page: 1 })).rejects.toMatchObject({ code: 'ORGKB_UNAUTHORIZED' })
    expect(manager.apiClient.knowledgeInspection).not.toHaveBeenCalled()
  })
  it.each(['OWNER', 'ADMIN'])('%s 在线核验后读取，离线核验失败阻断请求', async (role) => {
    const { inspection, manager, client } = auth(role)
    await inspection.spaces({ page: 2, keyword: '库' })
    expect(manager.retryVerification).toHaveBeenCalledTimes(1)
    expect(client.spaces).toHaveBeenCalledWith({ page: 2, keyword: '库' }, expect.any(Function))
    manager.retryVerification.mockRejectedValueOnce(new Error('offline'))
    await expect(inspection.spaces({ page: 1 })).rejects.toThrow('offline')
    expect(client.spaces).toHaveBeenCalledTimes(1)
  })
  it('切换企业后丢弃旧响应，不读取普通目录缓存', async () => {
    const { inspection, manager, client } = auth()
    client.spaces.mockImplementationOnce(async () => {
      manager.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return page([])
    })
    await expect(inspection.spaces({ page: 1 })).rejects.toMatchObject({ code: 'ORGKB_UNAUTHORIZED' })
  })
})
