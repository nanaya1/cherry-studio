import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProfileBootJournal } from '../ProfileBootJournal'

const temporaryDirectories: string[] = []
const PROFILE_ID = '0123456789abcdef0123456789abcdef'

async function createJournal(): Promise<ProfileBootJournal> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-boot-journal-'))
  temporaryDirectories.push(directory)
  return new ProfileBootJournal(path.join(directory, 'boot-journal.json'), { failureThreshold: 2 })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileBootJournal', () => {
  it('records attempts, failureCount, success, and lastKnownGood', async () => {
    const journal = await createJournal()

    await journal.beginAttempt(PROFILE_ID)
    expect(await journal.read()).toMatchObject({
      failureCount: 0,
      attempt: { profileId: PROFILE_ID, status: 'started' }
    })

    await journal.recordFailure(PROFILE_ID)
    expect(await journal.read()).toMatchObject({ failureCount: 1, attempt: { status: 'failed' } })

    await journal.beginAttempt(PROFILE_ID)
    await journal.recordSuccess(PROFILE_ID)
    expect(await journal.read()).toMatchObject({
      failureCount: 0,
      lastKnownGood: PROFILE_ID,
      attempt: { status: 'succeeded' }
    })
  })

  it('counts an unfinished started attempt as a failure on the next launch', async () => {
    const journal = await createJournal()
    await journal.beginAttempt(PROFILE_ID)
    await journal.beginAttempt(PROFILE_ID)

    expect(await journal.read()).toMatchObject({ failureCount: 1, attempt: { number: 2, status: 'started' } })
  })

  it('forces signed-out recovery after consecutive failures and never selects lastKnownGood automatically', async () => {
    const journal = await createJournal()
    await journal.beginAttempt(PROFILE_ID)
    await journal.recordSuccess(PROFILE_ID)

    await journal.beginAttempt(PROFILE_ID)
    await journal.recordFailure(PROFILE_ID)
    await journal.beginAttempt(PROFILE_ID)
    await journal.recordFailure(PROFILE_ID)

    expect(await journal.getRecoveryDecision(PROFILE_ID)).toEqual({ recover: true, profileId: 'signed-out' })
    expect(await journal.read()).toMatchObject({ failureCount: 2, lastKnownGood: PROFILE_ID })
  })

  it('allows a fresh boot after explicit authentication without marking business startup successful', async () => {
    const journal = await createJournal()
    await journal.beginAttempt(PROFILE_ID)
    await journal.recordFailure(PROFILE_ID)
    await journal.beginAttempt(PROFILE_ID)
    await journal.recordFailure(PROFILE_ID)
    await journal.resetAfterAuthentication()
    await journal.beginAttempt(PROFILE_ID)
    expect(await journal.getRecoveryDecision(PROFILE_ID)).toEqual({ recover: false, profileId: PROFILE_ID })
    expect(await journal.read()).toMatchObject({ failureCount: 0, attempt: { status: 'started' } })
    expect((await journal.read()).lastKnownGood).toBeUndefined()
  })

  it('fails closed when the journal is corrupt', async () => {
    const journal = await createJournal()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(journal.path, '{broken', 'utf8'))

    await expect(journal.getRecoveryDecision(PROFILE_ID)).resolves.toEqual({ recover: true, profileId: 'signed-out' })
  })
})
