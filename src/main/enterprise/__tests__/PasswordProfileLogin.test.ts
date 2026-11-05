import { describe, expect, it, vi } from 'vitest'

import { PasswordProfileLogin } from '../PasswordProfileLogin'

/* const user = { server_instance_id: 'server', user: { id: 7, group_id: 2, role: 'member', status: 'active' } }
function setup() {
  const requests: string[] = []
  const temporary = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url)
      if (url.endsWith('/login')) {
        expect(JSON.parse(String(init?.body))).toEqual({ identifier: 'alice', password: 'secret' })
        return new Response('{}')
      }
      return new Response(JSON.stringify(user))
    })
  }
  const completeAuthentication = vi.fn(async (auth: any) => {
    await auth.prepareTargetSession('/profiles/target')
    return { kind: 'relaunching' as const }
  })
  const prepareTarget = vi.fn(async () => undefined)
  const login = new PasswordProfileLogin({
    baseUrl: 'https://example.test',
    createTemporarySession: () => temporary,
    prepareTarget,
    clearTemporary: vi.fn(async () => undefined),
    completeAuthentication
  })
  return { login, requests, temporary, completeAuthentication, prepareTarget }
}

// 原 Cookie 登录测试保留，Java 契约见后续用例。
describe('PasswordProfileLogin', () => {
  it('validates modern identity and prepares the target jar before committing the switch', async () => {
    const { login, requests, prepareTarget, completeAuthentication } = setup()
    await expect(login.login('alice', 'secret')).resolves.toEqual({ kind: 'relaunching' })
    expect(requests).toEqual(['https://example.test/api/auth/login', 'https://example.test/api/currentuser'])
    expect(prepareTarget).toHaveBeenCalledWith(
      expect.anything(),
      '/profiles/target',
      expect.objectContaining({ userId: '7', issuerId: 'server' })
    )
    expect(completeAuthentication.mock.calls[0][0].session).toMatchObject({
      authMode: 'management-cookie',
      accessToken: '',
      groupId: '2'
    })
  })

  it('never commits when the password is rejected', async () => {
    const { login, temporary, completeAuthentication } = setup()
    temporary.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(login.login('alice', 'secret')).rejects.toThrow(/401/)
    expect(completeAuthentication).not.toHaveBeenCalled()
  })

  it('never commits an inactive account', async () => {
    const { login, temporary, completeAuthentication } = setup()
    temporary.fetch
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...user, user: { ...user.user, status: 'disabled' } })))
    await expect(login.login('alice', 'secret')).rejects.toThrow(/inactive/)
    expect(completeAuthentication).not.toHaveBeenCalled()
  })

  it('rejects a late password response after cancellation', async () => {
    const { login, temporary, completeAuthentication } = setup()
    let release!: (response: Response) => void
    temporary.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const pending = login.login('alice', 'secret')
    login.cancel()
    release(new Response('{}'))
    await expect(pending).rejects.toThrow(/stale/)
    expect(completeAuthentication).not.toHaveBeenCalled()
  })
})
*/

const profile = {
  serverInstanceId: 'server',
  userId: '7',
  tenantId: 'tenant',
  groupId: null,
  roleCode: 'member',
  username: 'alice'
}
function setupJava() {
  const client = {
    login: vi.fn(async () => ({ accessToken: 'raw-token', tenantId: 'tenant' })),
    fetchMe: vi.fn(async () => profile)
  }
  const completeAuthentication = vi.fn(async (auth: any) => {
    await auth.prepareTargetSession('/profiles/target')
    return { kind: 'relaunching' as const }
  })
  const login = new PasswordProfileLogin({ baseUrl: 'https://example.test', client, completeAuthentication })
  return { login, client, completeAuthentication }
}
describe('Java 密码登录事务', () => {
  it('复验身份后才提交无 Cookie 的 Java 会话', async () => {
    const { login, completeAuthentication } = setupJava()
    await expect(login.login(' alice ', 'secret')).resolves.toEqual({ kind: 'relaunching' })
    expect(completeAuthentication.mock.calls[0][0].session).toMatchObject({
      authMode: 'management-java',
      userId: '7',
      tenantId: 'tenant',
      groupId: null,
      expiresAt: null
    })
    expect(completeAuthentication.mock.calls[0][0].session).not.toHaveProperty('status')
  })
  it('企业不一致不进入 profile 事务', async () => {
    const { login, client, completeAuthentication } = setupJava()
    client.fetchMe.mockResolvedValueOnce({ ...profile, tenantId: 'other' })
    await expect(login.login('alice', 'secret')).rejects.toThrow(/企业/)
    expect(completeAuthentication).not.toHaveBeenCalled()
  })
  it('取消及重复提交不能提交迟到身份', async () => {
    const { login, client, completeAuthentication } = setupJava()
    let release!: (value: typeof profile) => void
    client.fetchMe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = login.login('alice', 'secret')
    await vi.waitFor(() => expect(client.fetchMe).toHaveBeenCalled())
    await expect(login.login('alice', 'secret')).rejects.toThrow()
    login.cancel()
    release(profile)
    await expect(pending).rejects.toThrow(/过期|stale/)
    expect(completeAuthentication).not.toHaveBeenCalled()
  })
})
