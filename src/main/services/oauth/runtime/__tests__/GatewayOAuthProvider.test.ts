import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('@shared/utils/systemProviderId', () => ({
  SystemProviderIds: { cherryin: 'cherryin' }
}))

import { net } from 'electron'

import { OAuthServiceError } from '../../errors'
import { createGatewayOAuthProvider } from '../providers/cherryin'

// The gateway OAuth definition now serves CherryIN only; 雪浪工匠 is
// provisioned from the Cowork model-config snapshot with no OAuth runtime.
describe('createGatewayOAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds the CherryIN definition with its legacy endpoints', () => {
    const def = createGatewayOAuthProvider('cherryin')

    expect(def.providerId).toBe('cherryin')
    expect(def.clientId).toBe('2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(def.transport).toEqual({
      type: 'loopback',
      config: {
        hosts: ['127.0.0.1'],
        port: 29873,
        path: '/oauth/callback',
        redirectUri: 'http://127.0.0.1:29873/oauth/callback'
      }
    })

    // PkceOAuthClient keeps its config private; the authorize URL it builds is
    // the observable contract (minus the per-request PKCE/state randomness).
    const request = (
      def.createClient({}) as { createAuthorizationRequest: () => { authUrl: string } }
    ).createAuthorizationRequest()
    expect(request.authUrl.startsWith('https://open.cherryin.ai/oauth2/auth?')).toBe(true)
    expect(request.authUrl).toContain('client_id=2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(request.authUrl).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A29873%2Foauth%2Fcallback')
  })

  it('rejects hosts outside the CherryIN allowlist', () => {
    const def = createGatewayOAuthProvider('cherryin')
    expect(() => def.createClient({ oauthServer: 'https://api.xuelanglm.com' })).toThrow(/Unauthorized API host/)
  })

  it('rejects providers without a gateway OAuth config', () => {
    expect(() => createGatewayOAuthProvider('xuelang')).toThrow(/No gateway OAuth config/)
  })

  it('preserves gateway API error codes for renderer i18n mapping', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'NO_ACTIVE_SUBSCRIPTION' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const def = createGatewayOAuthProvider('cherryin')

    const error = await def.provisionApiKeys?.('access-token', {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OAuthServiceError)
    expect(error).toHaveProperty('code', 'NO_ACTIVE_SUBSCRIPTION')
  })
})
