import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const sessionMock = vi.hoisted(() => ({
  defaultSession: { id: 'default-session' },
  fromPath: vi.fn((sessionPath: string) => ({ id: `profile:${sessionPath}` }))
}))

const launchContextMock = vi.hoisted(() => ({
  value: undefined as { mode: string; profileRoot: string } | undefined
}))

vi.mock('electron', () => ({ session: sessionMock }))
vi.mock('@main/core/profiles/ProfileRuntimeContext', () => ({
  getProfileLaunchContext: () => launchContextMock.value
}))

describe('getBusinessSession', () => {
  it('uses an isolated session path for an authenticated profile', async () => {
    launchContextMock.value = {
      mode: 'business',
      profileRoot: '/data/root/profiles/profile-a'
    }

    const { getBusinessSession } = await import('../profileSession')

    expect(getBusinessSession()).toEqual({
      id: `profile:${path.join('/data/root/profiles/profile-a', 'sessionData')}`
    })
    expect(sessionMock.fromPath).toHaveBeenCalledWith(
      path.join('/data/root/profiles/profile-a', 'sessionData')
    )
  })

  it('uses Electron defaultSession outside business mode', async () => {
    launchContextMock.value = { mode: 'signed-out', profileRoot: '/data/root/profiles/signed-out' }

    const { getBusinessSession } = await import('../profileSession')

    expect(getBusinessSession()).toBe(sessionMock.defaultSession)
    expect(sessionMock.fromPath).not.toHaveBeenCalled()
  })

  it('does not create a profile session when no launch context exists', async () => {
    launchContextMock.value = undefined

    const { getBusinessSession } = await import('../profileSession')

    expect(getBusinessSession()).toBe(sessionMock.defaultSession)
    expect(sessionMock.fromPath).not.toHaveBeenCalled()
  })
})
