import { shell } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'

import { openKnowledgeWebManagement } from '../KnowledgeWebManagement'
import type { OrgAuthManager } from '../OrgAuthManager'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('@main/i18n', async () => {
  const { default: messages } = await import('../../i18n/locales/zh-cn.json')
  return { t: (key: string) => messages[key as keyof typeof messages] }
})
vi.mock('../OrgApiClient', () => ({ ORG_SERVER_BASE_URL: 'https://management.test' }))
// const session = { authMode: 'management-java', role: 'ADMIN', tenantId: '20', userId: '7', accessToken: 'secret-token' }
const session = {
  authMode: 'management-java',
  authOrigin: 'https://management.test',
  role: 'ADMIN',
  tenantId: '20',
  userId: '7',
  accessToken: 'secret-token'
}
const ticket = 'a'.repeat(43)
const snapshot = { ticket, expiresIn: 60, userId: '7', tenantId: '20' }
const fetchMock = vi.fn()
const auth = {
  acquireLease: vi.fn(() => ({})),
  assertLease: vi.fn(),
  retryVerification: vi.fn(),
  getValidSession: vi.fn()
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 200, data: snapshot })))
  auth.getValidSession.mockResolvedValue(session)
})
const open = (target = { create: true }) => openKnowledgeWebManagement(auth as unknown as OrgAuthManager, target)

// 保护凭据不会进入URL、子路径部署可达且跳转不会直接创建资源。
it('管理员通过一次性票据进入创建页，源Token只送认证服务而不进入URL', async () => {
  vi.stubEnv('MAIN_VITE_ORG_WEB_BASE_URL', 'https://web.test/admin/')
  await open()
  const url = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
  // 原创建链接已被票据回调替代，详情页继续保留原账号与企业核对逻辑。
  // expect(url.pathname).toBe('/admin/knowledge')
  // expect(Object.fromEntries(url.searchParams)).toEqual({ clientTenantId: '20', clientUserId: '7', category: 'public', action: 'create' })
  expect(url.pathname).toBe('/admin/client/callback')
  expect(url.search).toBe('')
  expect(url.hash).toBe(`#ticket=${ticket}`)
  expect(url.href).not.toContain('secret-token')
  const [endpoint, init] = fetchMock.mock.calls[0]
  expect(String(endpoint)).toBe('https://management.test/api/v1/client/auth/web-ticket')
  expect(init).toMatchObject({
    method: 'POST',
    headers: { token: 'secret-token' },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit'
  })
})

it('网页管理详情继续使用原固定链接，不签发登录票据', async () => {
  await openKnowledgeWebManagement(auth as unknown as OrgAuthManager, {
    id: '00000000-0000-0000-0000-000000000001',
    create: false
  })
  const url = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
  expect(url.pathname).toBe('/knowledge/00000000-0000-0000-0000-000000000001')
  expect(Object.fromEntries(url.searchParams)).toEqual({ clientTenantId: '20', clientUserId: '7' })
  expect(url.hash).toBe('')
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([{ userId: '8' }, { tenantId: '21' }, { ticket: '../redirect' }, { expiresIn: 0 }])(
  '拒绝与源身份不符或格式无效的票据 %s',
  async (changed) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { ...snapshot, ...changed } })))
    await expect(open()).rejects.toThrow()
    expect(shell.openExternal).not.toHaveBeenCalled()
  }
)

it.each([10007, 10008, 500])('签发失败%s不降级为普通登录且不自动重发', async (code) => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code, msg: 'secret-token' })))
  await expect(open()).rejects.not.toThrow('secret-token')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(shell.openExternal).not.toHaveBeenCalled()
})

it('签发返回时身份已切换，丢弃旧票据', async () => {
  fetchMock.mockImplementation(async () => {
    auth.assertLease.mockImplementation(() => {
      throw new Error('stale')
    })
    return new Response(JSON.stringify({ code: 200, data: snapshot }))
  })
  await expect(open()).rejects.toThrow('stale')
  expect(shell.openExternal).not.toHaveBeenCalled()
})

it('浏览器打开失败时不透传包含票据的Electron异常', async () => {
  vi.mocked(shell.openExternal).mockRejectedValue(new Error(`Failed to open #ticket=${ticket}`))
  const failure = await open().then(
    () => null,
    (error: Error) => error
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure?.message).toBe('无法打开知识库创建页面，请从客户端重新尝试。')
})

it('畸形业务码不能进入错误提示', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'secret-token' })))
  await expect(open()).rejects.toThrow('无法打开知识库创建页面')
  expect(shell.openExternal).not.toHaveBeenCalled()
})

it.each(['MEMBER', '', 'PLATFORM_ADMIN'])('角色%s不能直接调用IPC打开管理', async (role) => {
  auth.getValidSession.mockResolvedValue({ ...session, role })
  await expect(open()).rejects.toThrow('仅当前企业管理员')
  expect(shell.openExternal).not.toHaveBeenCalled()
})

it.each(['file:///tmp/admin', 'javascript:alert(1)', 'https://name:secret@web.test', 'https://web.test/?token=secret'])(
  '拒绝不安全网页配置%s',
  async (value) => {
    vi.stubEnv('MAIN_VITE_ORG_WEB_BASE_URL', value)
    await expect(open()).rejects.toThrow()
    expect(shell.openExternal).not.toHaveBeenCalled()
  }
)

it('重新核查期间身份切换时不打开旧企业链接', async () => {
  auth.assertLease.mockImplementation(() => {
    throw new Error('stale')
  })
  await expect(open()).rejects.toThrow('stale')
  expect(shell.openExternal).not.toHaveBeenCalled()
})
