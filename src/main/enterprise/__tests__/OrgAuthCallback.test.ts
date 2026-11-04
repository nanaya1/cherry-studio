import { describe, expect, it } from 'vitest'

import { parseOrgAuthCallback } from '../types'

describe('parseOrgAuthCallback (PKCE code+state)', () => {
  it('接受带 state 的 OAuth error，拒绝缺失 state 及错误入口', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?error=access_denied&state=xyz'))).toEqual({
      error: 'access_denied',
      state: 'xyz'
    })
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?error=access_denied'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://other/sso/callback?error=access_denied&state=xyz'))).toBeNull()
  })

  it('接受 PKCE 回调 meacowork://auth/sso/callback?code&state', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?code=abc&state=xyz'))).toEqual({
      code: 'abc',
      state: 'xyz'
    })
  })

  // [enterprise] 旧官网 SSO 路径 /sso/callback 一律拒绝，即使带 code+state 也不认
  it('拒绝错误 host（非 auth）', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://other/callback?code=abc&state=xyz'))).toBeNull()
  })

  it('拒绝非 meacowork scheme', () => {
    expect(parseOrgAuthCallback(new URL('http://auth/callback?code=abc&state=xyz'))).toBeNull()
  })

  it('拒绝缺少 code 或 state 的回调', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?code=abc'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?state=xyz'))).toBeNull()
  })
})
