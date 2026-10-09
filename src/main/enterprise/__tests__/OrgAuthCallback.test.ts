import { describe, expect, it } from 'vitest'
import { parseOrgAuthCallback } from '../types'

describe('parseOrgAuthCallback', () => {
  it('接受新的 SSO 回调路径和 token 参数', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback?token=official-token'))).toEqual({
      token: 'official-token',
    })
  })

  it('拒绝旧回调路径、错误路径和缺少 token 的回调', () => {
    expect(parseOrgAuthCallback(new URL('meacowork://auth/callback?token=official-token'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/other?token=official-token'))).toBeNull()
    expect(parseOrgAuthCallback(new URL('meacowork://auth/sso/callback'))).toBeNull()
  })
})
