import { describe, expect, it } from 'vitest'

import { createProfileDiagnostics } from '..'

describe('createProfileDiagnostics', () => {
  it('returns only the planned fields for a ready profile', () => {
    const diagnostics = createProfileDiagnostics({
      enabled: true,
      profileType: 'authenticated',
      profileId: '0123456789abcdef0123456789abcdef',
      dataRoot: '/var/lib/cherry-studio',
      profileRoot: '/var/lib/cherry-studio/profiles/0123456789abcdef0123456789abcdef',
      controlState: 'ready',
      identity: {
        issuerId: 'issuer-secret',
        subjectId: 'subject-secret',
        groupId: 'group-secret',
        username: 'secret-user',
        phoneNumber: '13800000000',
        token: 'secret-token',
        canonicalIdentity: 'v2\0authenticated\0management\0issuer-secret\0subject-secret'
      }
    } as Parameters<typeof createProfileDiagnostics>[0])

    expect(diagnostics).toEqual({
      enabled: true,
      profileType: 'authenticated',
      profileId: '0123456789abcdef0123456789abcdef',
      dataRoot: '/var/lib/cherry-studio',
      profileRoot: '/var/lib/cherry-studio/profiles/0123456789abcdef0123456789abcdef',
      controlState: 'ready'
    })
    expect(Object.keys(diagnostics).sort()).toEqual([
      'controlState',
      'dataRoot',
      'enabled',
      'profileId',
      'profileRoot',
      'profileType'
    ])
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /issuer-secret|subject-secret|group-secret|secret-user|13800000000|secret-token|canonicalIdentity/
    )
  })

  it('omits optional profile fields when control state is not initialized', () => {
    expect(createProfileDiagnostics({ enabled: false, controlState: 'not-initialized' })).toEqual({
      enabled: false,
      controlState: 'not-initialized'
    })
  })

  it.each(['signed-out', 'local', 'authenticated'] as const)('preserves planned profile type %s', (profileType) => {
    expect(createProfileDiagnostics({ enabled: true, profileType, controlState: 'corrupt' })).toEqual({
      enabled: true,
      profileType,
      controlState: 'corrupt'
    })
  })

  it('returns a new summary and does not mutate its input', () => {
    const input = Object.freeze({
      enabled: true,
      profileType: 'local' as const,
      profileId: '0123456789abcdef0123456789abcdef',
      controlState: 'ready' as const
    })

    const diagnostics = createProfileDiagnostics(input)

    expect(diagnostics).not.toBe(input)
    expect(input).toEqual({
      enabled: true,
      profileType: 'local',
      profileId: '0123456789abcdef0123456789abcdef',
      controlState: 'ready'
    })
  })
})
