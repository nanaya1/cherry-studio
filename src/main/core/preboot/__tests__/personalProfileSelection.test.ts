import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readPersonalProfileSelection, writePersonalProfileSelection } from '../personalProfileSelection'

describe('personal profile selection', () => {
  it('defaults to the legacy guest, reads a committed account, and returns to guest after logout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mea-profile-selection-'))
    try {
      const account = { kind: 'account', serverInstanceId: 'instance', userId: '7' } as const
      expect(readPersonalProfileSelection(root)).toEqual({ kind: 'guest' })
      writePersonalProfileSelection(root, account)
      expect(readPersonalProfileSelection(root)).toEqual(account)
      const namedAccount = { ...account, username: 'demo', displayName: 'Demo User' }
      writePersonalProfileSelection(root, namedAccount)
      expect(readPersonalProfileSelection(root)).toEqual(namedAccount)
      writePersonalProfileSelection(root, { kind: 'guest' })
      expect(readPersonalProfileSelection(root)).toEqual({ kind: 'guest' })
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  it('does not treat a corrupt selection as an implicit logout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mea-profile-selection-'))
    try {
      writeFileSync(path.join(root, 'personal-profile.json'), '{"version":1,"kind":"account","userId":"../guest"}')
      expect(() => readPersonalProfileSelection(root)).toThrow('Invalid personal profile selection')
    } finally {
      rmSync(root, { recursive: true })
    }
  })
})
