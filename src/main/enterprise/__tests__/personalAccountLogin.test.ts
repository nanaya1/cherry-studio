import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { loginPersonalAccount } from '../personalAccountLogin'

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const baseUrl = 'https://cowork.example'
const input = { username: 'demo', password: 'test-password' }

describe('loginPersonalAccount', () => {
  it('uses the first-party token to resolve the authenticated account and tenant', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, options) => {
      if (url === `${baseUrl}/api/v1/auth/login`) {
        const body = JSON.parse(String(options?.body))
        expect(body).toMatchObject({ username: 'demo', loginSource: 'CLIENT' })
        expect(Buffer.from(body.password, 'base64')).toHaveLength(256)
        expect(body.password).not.toBe(input.password)
        return Response.json({ code: 200, data: { accessToken: 'session', needSelectTenant: false } })
      }
      expect(url).toBe(`${baseUrl}/api/v1/auth/me`)
      expect(new Headers(options?.headers).get('token')).toBe('session')
      return Response.json({ code: 200, data: { serverInstanceId: 'instance', id: 7, tenantId: 2 } })
    })
    await expect(
      loginPersonalAccount({ baseUrl, publicKey, fetch }, input, new AbortController().signal)
    ).resolves.toEqual({
      accessToken: 'session',
      serverInstanceId: 'instance',
      userId: '7',
      username: 'demo',
      displayName: 'demo'
    })
  })

  it('rejects a session with no selected tenant', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ code: 200, data: { accessToken: 'session', needSelectTenant: false } }))
      .mockResolvedValueOnce(
        Response.json({ code: 200, data: { serverInstanceId: 'instance', id: 7, tenantId: null } })
      )
    await expect(
      loginPersonalAccount({ baseUrl, publicKey, fetch }, input, new AbortController().signal)
    ).rejects.toThrow('missing default tenant')
  })
})
