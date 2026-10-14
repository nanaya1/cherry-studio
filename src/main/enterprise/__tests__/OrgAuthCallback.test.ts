import { describe, expect, it } from 'vitest'

import { parseOrgAuthCallback } from '../types'

describe('parseOrgAuthCallback', () => {
  it('接受新的 SSO 回调路径和 token 参数', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?token=official-token'))).toEqual({
      token: 'official-token'
    })
  })

  it('接受管理端 OAuth 回调路径和 code/state 参数', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/callback?code=auth-code&state=known-state'))).toEqual({
      code: 'auth-code',
      state: 'known-state'
    })
  })

  it('拒绝错误路径和缺少必要参数的回调', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/other?token=official-token'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/callback?code=auth-code'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/callback?state=known-state'))).toBeNull()
  })
})
