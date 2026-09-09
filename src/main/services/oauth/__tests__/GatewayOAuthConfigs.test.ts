import { describe, expect, it } from 'vitest'

import { GATEWAY_OAUTH_CONFIGS } from '../CherryInOAuthConfig'

// 雪浪工匠 and CherryIN share one gateway OAuth implementation. These tests pin
// the per-provider config table: same PKCE contract, different hosts.
describe('GATEWAY_OAUTH_CONFIGS', () => {
  it('keeps the CherryIN legacy values untouched', () => {
    const config = GATEWAY_OAUTH_CONFIGS.cherryin

    expect(config.CLIENT_ID).toBe('2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(config.ALLOWED_HOSTS).toEqual(['https://open.cherryin.ai', 'https://open.cherryin.dev'])
    expect(config.REDIRECT_URI).toBe('meacowork://oauth/callback')
    expect(config.SCOPES).toBe('openid profile email offline_access balance:read usage:read tokens:read tokens:write')
  })

  it('registers the xuelang gateway behind its current host', () => {
    const config = GATEWAY_OAUTH_CONFIGS.xuelang

    expect(config.CLIENT_ID).toBe(GATEWAY_OAUTH_CONFIGS.cherryin.CLIENT_ID)
    expect(config.REDIRECT_URI).toBe(GATEWAY_OAUTH_CONFIGS.cherryin.REDIRECT_URI)
    expect(config.SCOPES).toBe(GATEWAY_OAUTH_CONFIGS.cherryin.SCOPES)
    expect(config.ALLOWED_HOSTS).toEqual(['https://api.xuelanglm.com'])
  })
})
