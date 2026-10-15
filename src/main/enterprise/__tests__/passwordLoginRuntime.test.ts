import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ temporary: null as any, target: null as any }))
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
