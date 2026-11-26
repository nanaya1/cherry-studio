import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readPersonalProfileSelection, writePersonalProfileSelection } from '../personalProfileSelection'
import { PersonalProfileSwitch } from '../personalProfileSwitch'

const target = { kind: 'account', serverInstanceId: 'instance', userId: '7' } as const
let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mea-personal-switch-'))
})

afterEach(() => {
  rmSync(root, { recursive: true })
})

describe('PersonalProfileSwitch', () => {
  it('keeps the guest selected until teardown completes, then relaunches into the target account', async () => {
    const stopped = Promise.withResolvers<{ clean: boolean }>()
    const enteredTeardown = Promise.withResolvers<void>()
    const relaunch = vi.fn(() => expect(readPersonalProfileSelection(root)).toEqual(target))
    const coordinator = new PersonalProfileSwitch({
      confirmSwitch: async () => true,
      stopCurrentProfile: () => {
        enteredTeardown.resolve()
        return stopped.promise
      },
      commitSelection: (profile) => writePersonalProfileSelection(root, profile),
      relaunch
    })

    const result = coordinator.switchTo(target)
    await enteredTeardown.promise
    expect(readPersonalProfileSelection(root)).toEqual({ kind: 'guest' })
    await expect(coordinator.switchTo(target)).resolves.toBe('busy')
    stopped.resolve({ clean: true })
    await expect(result).resolves.toBe('relaunching')
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('does not commit or relaunch after a failed teardown', async () => {
    const relaunch = vi.fn()
    const coordinator = new PersonalProfileSwitch({
      confirmSwitch: async () => true,
      stopCurrentProfile: async () => ({ clean: false }),
      commitSelection: (profile) => writePersonalProfileSelection(root, profile),
      relaunch
    })

    await expect(coordinator.switchTo(target)).rejects.toThrow('did not stop cleanly')
    expect(readPersonalProfileSelection(root)).toEqual({ kind: 'guest' })
    expect(relaunch).not.toHaveBeenCalled()
    await expect(coordinator.switchTo(target)).resolves.toBe('busy')
  })

  it('lets the user cancel before stopping work and retry the switch later', async () => {
    const stopCurrentProfile = vi.fn(async () => ({ clean: true }))
    const coordinator = new PersonalProfileSwitch({
      confirmSwitch: vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      stopCurrentProfile,
      commitSelection: (profile) => writePersonalProfileSelection(root, profile),
      relaunch: () => {}
    })
    await expect(coordinator.switchTo(target)).resolves.toBe('cancelled')
    expect(stopCurrentProfile).not.toHaveBeenCalled()
    expect(readPersonalProfileSelection(root)).toEqual({ kind: 'guest' })
    await expect(coordinator.switchTo(target)).resolves.toBe('relaunching')
  })
})
