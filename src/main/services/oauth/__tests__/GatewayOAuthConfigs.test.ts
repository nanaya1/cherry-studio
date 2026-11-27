import { describe, expect, it } from 'vitest'

import { GATEWAY_OAUTH_CONFIGS } from '../CherryInOAuthConfig'

// 雪浪工匠 no longer uses OAuth; only CherryIN remains in the gateway config table.
describe('GATEWAY_OAUTH_CONFIGS', () => {
  it('keeps the CherryIN legacy values untouched', () => {
    const config = GATEWAY_OAUTH_CONFIGS.cherryin

    expect(config.CLIENT_ID).toBe('2a348c87-bae1-4756-a62f-b2e97200fd6d')
    expect(config.ALLOWED_HOSTS).toEqual(['https://open.cherryin.ai', 'https://open.cherryin.dev'])
    expect(config.REDIRECT_URI).toBe('http://127.0.0.1:29873/oauth/callback')
    expect(config.SCOPES).toBe('openid profile email offline_access balance:read usage:read tokens:read tokens:write')
  })

  it('no longer registers a xuelang OAuth gateway', () => {
    expect(Object.keys(GATEWAY_OAUTH_CONFIGS)).toEqual(['cherryin'])
  })
})
