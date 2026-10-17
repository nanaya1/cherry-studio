import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireDataRootLock, releaseDataRootLock } from '../dataRootLock'

const temporaryRoots: string[] = []

afterEach(() => {
  releaseDataRootLock()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('dataRootLock', () => {
  it('acquires synchronously and can acquire again after release', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cherry-data-root-lock-'))
    temporaryRoots.push(root)

    expect(acquireDataRootLock(root)).toBe(true)

    releaseDataRootLock()

    expect(acquireDataRootLock(root)).toBe(true)
  })
})
