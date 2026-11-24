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
const session = { authMode: 'management-java', role: 'ADMIN', tenantId: '20', userId: '7', accessToken: 'secret-token' }
const auth = {
  acquireLease: vi.fn(() => ({})),
  assertLease: vi.fn(),
  retryVerification: vi.fn(),
  getValidSession: vi.fn()
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  auth.getValidSession.mockResolvedValue(session)
})
const open = (target = { create: true }) => openKnowledgeWebManagement(auth as unknown as OrgAuthManager, target)

// 保护凭据不会进入URL、子路径部署可达且跳转不会直接创建资源。
it('管理员跳公共创建表单，仅固定路由及账号企业标识进入URL', async () => {
  vi.stubEnv('MAIN_VITE_ORG_WEB_BASE_URL', 'https://web.test/admin/')
  await open()
  const url = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
  expect(url.pathname).toBe('/admin/knowledge')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    clientTenantId: '20',
    clientUserId: '7',
    category: 'public',
    action: 'create'
  })
  expect(url.href).not.toContain('secret-token')
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
