import { unlink } from 'node:fs/promises'

import { withProfileControlLock } from './ProfileControlLock'
import { type ControlMutationResult, ProfileControlStore, type ControlReadResult } from './ProfileControlStore'
import { type ProfileSwitchJournalV1, ProfileSwitchJournalV1Schema } from './ProfileSchemas'

type PreparedJournal = Extract<ProfileSwitchJournalV1, { phase: 'prepared' }>
type CommittedJournal = Extract<ProfileSwitchJournalV1, { phase: 'committed' }>

export interface PrepareProfileSwitch {
  operationId: string
  fromProfileId: string
  targetProfileId: string
  targetIdentityDigest: string
}

export interface CommitProfileSwitch {
  operationId: string
  targetProfileId: string
  targetIdentityDigest: string
}

export class ProfileSwitchJournal {
  private readonly store: ProfileControlStore<ProfileSwitchJournalV1>
  private readonly latestCommittedStore: ProfileControlStore<ProfileSwitchJournalV1>
  private readonly latestCancelledStore: ProfileControlStore<ProfileSwitchJournalV1>

  constructor(filePathOrStore: string | ProfileControlStore<ProfileSwitchJournalV1>) {
    this.store =
      typeof filePathOrStore === 'string'
        ? new ProfileControlStore(filePathOrStore, ProfileSwitchJournalV1Schema)
        : filePathOrStore
    this.latestCommittedStore = new ProfileControlStore(
      `${this.store.path}.committed`,
      ProfileSwitchJournalV1Schema.refine((value) => value.phase === 'committed', 'Expected a committed switch journal')
    )
    this.latestCancelledStore = new ProfileControlStore(
      `${this.store.path}.cancelled`,
      ProfileSwitchJournalV1Schema.refine((value) => value.phase === 'prepared', 'Expected a prepared switch journal')
    )
  }

  read(): Promise<ControlReadResult<ProfileSwitchJournalV1>> {
    return this.store.read()
  }

  readLatestCommitted(): Promise<ControlReadResult<ProfileSwitchJournalV1>> {
    return this.latestCommittedStore.read()
  }

  async prepare(request: PrepareProfileSwitch): Promise<ControlMutationResult<PreparedJournal>> {
    return withProfileControlLock(this.store.path, async () => {
      const existing = await this.store.read()
      if (existing.kind === 'corrupt') {
        throw new Error(`Profile switch journal is corrupt at ${existing.filePath}: ${existing.error}`)
      }
      if (existing.kind === 'ok') {
        if (existing.value.phase === 'committed') {
          const archived = await this.latestCommittedStore.write(existing.value)
          if (archived.kind === 'committed-durability-unknown') {
            throw new Error(`Could not durably archive committed profile switch: ${archived.error}`)
          }
        } else {
          this.assertPreparedMatches(existing.value, request)
          return { value: existing.value, durability: { kind: 'not-written' } }
        }
      }

      const prepared = ProfileSwitchJournalV1Schema.parse({
        version: 1,
        phase: 'prepared',
        ...request,
        createdAt: new Date().toISOString()
      }) as PreparedJournal
      const durability = await this.store.write(prepared)
      return { value: prepared, durability }
    })
  }

  async cancel(operationId: string): Promise<ControlMutationResult<PreparedJournal>> {
    return withProfileControlLock(this.store.path, async () => {
      const existing = await this.store.read()
      if (existing.kind === 'none') throw new Error('Prepared profile switch journal not found')
      if (existing.kind === 'corrupt') {
        throw new Error(`Profile switch journal is corrupt at ${existing.filePath}: ${existing.error}`)
      }
      if (existing.value.phase !== 'prepared') throw new Error('Committed profile switch cannot be cancelled')
      if (existing.value.operationId !== operationId) {
        throw new Error('Profile switch operation does not match prepared journal')
      }

      const archived = await this.latestCancelledStore.write(existing.value)
      if (archived.kind === 'committed-durability-unknown') {
        return { value: existing.value, durability: archived }
      }
      await unlink(this.store.path)
      return { value: existing.value, durability: archived }
    })
  }

  async commit(request: CommitProfileSwitch): Promise<ControlMutationResult<CommittedJournal>> {
    return withProfileControlLock(this.store.path, async () => {
      const existing = await this.store.read()
      if (existing.kind === 'none') {
        throw new Error('Prepared profile switch journal not found')
      }
      if (existing.kind === 'corrupt') {
        throw new Error(`Profile switch journal is corrupt at ${existing.filePath}: ${existing.error}`)
      }
      if (existing.value.phase !== 'prepared') {
        throw new Error('Profile switch journal is already committed')
      }
      this.assertPreparedMatches(existing.value, request)

      const committed = ProfileSwitchJournalV1Schema.parse({
        ...existing.value,
        phase: 'committed',
        committedAt: new Date().toISOString()
      }) as CommittedJournal
      const durability = await this.store.write(committed)
      return { value: committed, durability }
    })
  }

  private assertPreparedMatches(prepared: PreparedJournal, request: CommitProfileSwitch): void {
    if (prepared.operationId !== request.operationId) {
      throw new Error('Profile switch operation does not match prepared journal')
    }
    if (
      prepared.targetProfileId !== request.targetProfileId ||
      prepared.targetIdentityDigest !== request.targetIdentityDigest
    ) {
      throw new Error('Profile switch target does not match prepared journal')
    }
  }
}
