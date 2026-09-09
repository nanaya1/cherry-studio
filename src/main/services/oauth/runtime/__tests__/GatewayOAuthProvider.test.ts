import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('@shared/utils/systemProviderId', () => ({
  SystemProviderIds: { cherryin: 'cherryin', xuelang: 'xuelang' }
}))

import { createGatewayOAuthProvider } from '../providers/cherryin'

// The gateway OAuth definition is one factory serving every gateway provider —
// CherryIN keeps its exact legacy endpoints, xuelang points at its own host.
describe('createGatewayOAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds the CherryIN definition with its legacy endpoints', () => {
    const def = createGatewayOAuthProvider('cherryin')

    expect(def.providerId).toBe('cherryin')
    expect(def.clientId).toBe('2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(def.transport).toEqual({ type: 'deep-link', config: { redirectUri: 'meacowork://oauth/callback' } })

    // PkceOAuthClient keeps its config private; the authorize URL it builds is
    // the observable contract (minus the per-request PKCE/state randomness).
    const request = (def.createClient({}) as { createAuthorizationRequest: () => { authUrl: string } })
      .createAuthorizationRequest()
    expect(request.authUrl.startsWith('https://open.cherryin.ai/oauth2/auth?')).toBe(true)
    expect(request.authUrl).toContain('client_id=2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(request.authUrl).toContain('redirect_uri=meacowork%3A%2F%2Foauth%2Fcallback')
  })

  it('builds the xuelang definition pointing at the xuelang host', () => {
    const def = createGatewayOAuthProvider('xuelang')

    expect(def.providerId).toBe('xuelang')
    expect(def.clientId).toBe('2a348c87-bae1-4756-a62f-b2e97200fd6d')

    const request = (def.createClient({}) as { createAuthorizationRequest: () => { authUrl: string } })
      .createAuthorizationRequest()
    expect(request.authUrl).toContain('https://api.xuelanglm.com/oauth2/auth?')
    expect(request.authUrl).toContain('client_id=2a348c87-bae1-4756-a62f-b2e97200fd6d')
  })

  it('rejects hosts outside the provider allowlist', () => {
    const def = createGatewayOAuthProvider('cherryin')
    expect(() => def.createClient({ oauthServer: 'https://api.xuelanglm.com' })).toThrow(/Unauthorized API host/)
  })
})
