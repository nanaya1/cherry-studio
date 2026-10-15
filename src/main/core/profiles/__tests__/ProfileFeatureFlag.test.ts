import { describe, expect, it } from 'vitest'

import { isProfileIsolationEnabled } from '..'

describe('isProfileIsolationEnabled', () => {
  it('enables packaged profile isolation only through the production BootConfig source', () => {
    expect(
      isProfileIsolationEnabled({
        isPackaged: true,
        profileIsolationEnabled: true,
        env: { CS_PROFILE_ISOLATION: '0' }
      })
    ).toBe(true)
    expect(
      isProfileIsolationEnabled({
        isPackaged: true,
        profileIsolationEnabled: false,
        env: { CS_PROFILE_ISOLATION: '1' }
      })
    ).toBe(false)
  })

  it('allows the exact env value 1 to override BootConfig only in development', () => {
    expect(
      isProfileIsolationEnabled({
        isPackaged: false,
        profileIsolationEnabled: false,
        env: { CS_PROFILE_ISOLATION: '1' }
      })
    ).toBe(true)
  })

  it.each([undefined, '', '0', 'true', 'TRUE', ' 1 ', '01'])(
    'uses the BootConfig value for non-enabling development environment value %j',
    (value) => {
      expect(
        isProfileIsolationEnabled({
          isPackaged: false,
          profileIsolationEnabled: true,
          env: { CS_PROFILE_ISOLATION: value }
        })
      ).toBe(true)
    }
  )

  it('depends only on explicit inputs and does not require Electron', () => {
    const input = { isPackaged: false, profileIsolationEnabled: false, env: { CS_PROFILE_ISOLATION: '1' } }
    expect(isProfileIsolationEnabled(input)).toBe(true)
    expect(isProfileIsolationEnabled(input)).toBe(true)
  })
})
