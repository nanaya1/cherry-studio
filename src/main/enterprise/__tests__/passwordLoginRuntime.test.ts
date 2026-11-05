import { describe, expect, it, vi } from 'vitest'

/* const state = vi.hoisted(() => ({ temporary: null as any, target: null as any }))
const sessions = { fromPartition: () => state.temporary, fromPath: () => state.target } as any
vi.mock('../OrgApiClient', () => ({ ORG_SERVER_BASE_URL: 'https://example.test' }))
import { createPasswordProfileLogin } from '../passwordLoginRuntime'

function jar(sid: string, userId = 7) {
  let value = sid
  return {
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            server_instance_id: 'server',
            user: { id: userId, group_id: 2, role: 'member', status: 'active' }
          })
        )
    ),
    cookies: {
      get: vi.fn(async () =>
        value
          ? [
              {
                name: 'sid',
                value,
                path: '/',
                domain: 'example.test',
                session: false,
                secure: true,
                httpOnly: true,
                expirationDate: 2000000000
              }
            ]
          : []
      ),
      set: vi.fn(async (cookie: { value: string }) => {
        value = cookie.value
      }),
      remove: vi.fn(async () => {
        value = ''
      }),
      flushStore: vi.fn(async () => undefined)
    },
    value: () => value
  }
}

describe('password login cookie preparation', () => {
  it('flushes the target cookie before switching and cleans the temporary cookie', async () => {
    state.temporary = jar('new')
    state.target = jar('old')
    let committed = false
    const login = createPasswordProfileLogin(
      {
        completeAuthentication: async (auth: any) => {
          await auth.prepareTargetSession('/profiles/target')
          expect(state.target.value()).toBe('new')
          expect(state.target.cookies.flushStore).toHaveBeenCalled()
          committed = true
          return { kind: 'relaunching' }
        }
      } as any,
      sessions
    )
    await login.login('alice', 'secret')
    expect(committed).toBe(true)
    expect(state.temporary.value()).toBe('')
  })

  it('restores the old target cookie and never commits when target identity differs', async () => {
    state.temporary = jar('new')
    state.target = jar('old', 9)
    let committed = false
    const login = createPasswordProfileLogin(
      {
        completeAuthentication: async (auth: any) => {
          await auth.prepareTargetSession('/profiles/target')
          committed = true
          return { kind: 'relaunching' }
        }
      } as any,
      sessions
    )
    await expect(login.login('alice', 'secret')).rejects.toThrow(/identity/)
    expect(committed).toBe(false)
    expect(state.target.value()).toBe('old')
    expect(state.temporary.value()).toBe('')
  })
})
*/

const client = vi.hoisted(() => ({ login: vi.fn(), fetchMe: vi.fn() }))
vi.mock('../OrgApiClient', () => ({ ORG_SERVER_BASE_URL: 'https://example.test' }))
vi.mock('../JavaAuthClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  JavaAuthClient: class {
    login = client.login
    fetchMe = client.fetchMe
  }
}))
import { createPasswordProfileLogin } from '../passwordLoginRuntime'

describe('Java 登录运行时', () => {
  it('将复验的原始令牌和 null 分组交给原 profile 事务', async () => {
    client.login.mockResolvedValue({ accessToken: 'raw-token', tenantId: 'tenant' })
    client.fetchMe.mockResolvedValue({
      serverInstanceId: 'server',
      userId: '7',
      tenantId: 'tenant',
      groupId: null,
      roleCode: 'member',
      username: 'alice'
    })
    let saved: any
    const login = createPasswordProfileLogin({
      completeAuthentication: async (auth: any) => {
        await auth.prepareTargetSession('/profiles/target')
        saved = auth.session
        return { kind: 'relaunching' }
      }
    } as any)
    await expect(login.login('alice', 'secret')).resolves.toEqual({ kind: 'relaunching' })
    expect(saved).toMatchObject({
      authMode: 'management-java',
      accessToken: 'raw-token',
      groupId: null,
      tenantId: 'tenant',
      expiresAt: null
    })
    expect(saved).not.toHaveProperty('status')
  })
})
