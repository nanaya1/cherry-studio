import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ProfileLaunchContext } from '../../profiles'
import {
  applyProfileIsolationPaths,
  deriveProfileDataRoot,
  lockProfileDataRoot,
  resolveProfileDataRoot,
  runProfileIsolationPreboot
} from '../profileIsolationPreboot'

const context: ProfileLaunchContext = {
  mode: 'business',
  profileId: '0123456789abcdef0123456789abcdef',
  identityDigest: 'a'.repeat(64),
  kind: 'authenticated',
  dataRoot: '/data/root',
  profileRoot: '/data/root/profiles/0123456789abcdef0123456789abcdef'
}

describe('runProfileIsolationPreboot', () => {
  it('derives a sibling profile dataRoot outside the legacy userData tree', () => {
    expect(deriveProfileDataRoot('/Library/Application Support/MEACowork')).toBe(
      '/Library/Application Support/MEACowork.profiles-v2'
    )
  })

  it('uses the executable-specific BootConfig dataRoot and otherwise falls back to the legacy sibling', () => {
    expect(resolveProfileDataRoot('/legacy/user-data', '/mock/exe', { '/mock/exe': '/custom/profile-root' })).toBe(
      '/custom/profile-root'
    )
    expect(resolveProfileDataRoot('/legacy/user-data', '/mock/exe', { '/other/exe': '/other/root' })).toBe(
      deriveProfileDataRoot('/legacy/user-data')
    )
  })

  it('exposes separate fixed-root lock and final profile path phases', () => {
    const calls: string[] = []
    const electron = {
      setPath: vi.fn((name: string, value: string) => calls.push(`set:${name}:${value}`)),
      setAppLogsPath: vi.fn((value: string) => calls.push(`logs:${value}`)),
      mkdirSync: vi.fn((value: string) => calls.push(`mkdir:${value}`)),
      requestSingleInstanceLock: vi.fn(() => {
        calls.push('lock')
        return true
      }),
      rebindLogger: vi.fn((value: string) => calls.push(`logger:${value}`)),
      freezePathRegistry: vi.fn(() => calls.push('freeze'))
    }

    expect(lockProfileDataRoot(context.dataRoot, electron)).toBe(true)
    expect(calls).toEqual([
      `mkdir:${path.join(context.dataRoot, 'control', 'electron-instance')}`,
      `set:userData:${path.join(context.dataRoot, 'control', 'electron-instance')}`,
      'lock'
    ])

    applyProfileIsolationPaths(context, electron)
    expect(calls).toContain(`logger:${path.join(context.profileRoot, 'logs')}`)
    expect(calls.at(-1)).toBe('freeze')
  })

  it('locks the fixed dataRoot before profile selection, then applies all final paths before freezing', async () => {
    const calls: string[] = []
    const setPath = vi.fn((name: string, value: string) => calls.push(`set:${name}:${value}`))
    const mkdirSync = vi.fn((value: string) => calls.push(`mkdir:${value}`))
    const requestSingleInstanceLock = vi.fn(() => {
      calls.push('lock')
      return true
    })
    const initializeProfile = vi.fn(async () => {
      calls.push('initialize')
      return context
    })
    const freezePathRegistry = vi.fn(() => calls.push('freeze'))

    const result = await runProfileIsolationPreboot(context.dataRoot, initializeProfile, {
      setPath,
      setAppLogsPath: (value) => calls.push(`logs:${value}`),
      mkdirSync,
      requestSingleInstanceLock,
      freezePathRegistry
    })

    const lockRoot = path.join(context.dataRoot, 'control', 'electron-instance')
    expect(result).toEqual(context)
    expect(calls.slice(0, 4)).toEqual([`mkdir:${lockRoot}`, `set:userData:${lockRoot}`, 'lock', 'initialize'])
    expect(setPath).toHaveBeenCalledWith('userData', path.join(context.profileRoot, 'userData'))
    expect(setPath).toHaveBeenCalledWith('sessionData', path.join(context.profileRoot, 'sessionData'))
    expect(setPath).toHaveBeenCalledWith('crashDumps', path.join(context.profileRoot, 'crashDumps'))
    expect(setPath).toHaveBeenCalledWith('temp', path.join(context.profileRoot, 'temp'))
    expect(calls).toContain(`logs:${path.join(context.profileRoot, 'logs')}`)
    expect(calls.at(-1)).toBe('freeze')
  })

  it('does not initialize a profile, apply final paths, or freeze when the lock is denied', async () => {
    const setPath = vi.fn()
    const initializeProfile = vi.fn(async () => context)
    const freezePathRegistry = vi.fn()

    const result = await runProfileIsolationPreboot(context.dataRoot, initializeProfile, {
      setPath,
      setAppLogsPath: vi.fn(),
      mkdirSync: vi.fn(),
      requestSingleInstanceLock: () => false,
      freezePathRegistry
    })

    expect(result).toBeUndefined()
    expect(setPath).toHaveBeenCalledTimes(1)
    expect(initializeProfile).not.toHaveBeenCalled()
    expect(freezePathRegistry).not.toHaveBeenCalled()
  })
})
