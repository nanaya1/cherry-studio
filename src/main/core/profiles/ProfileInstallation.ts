import { randomUUID } from 'node:crypto'

import { withProfileControlLock } from './ProfileControlLock'
import { type ControlMutationResult, ProfileControlStore } from './ProfileControlStore'
import { type InstallationRecordV1, InstallationRecordV1Schema } from './ProfileSchemas'

export class ProfileInstallation {
  private readonly store: ProfileControlStore<InstallationRecordV1>
  private inFlight: Promise<ControlMutationResult<InstallationRecordV1>> | undefined

  constructor(filePathOrStore: string | ProfileControlStore<InstallationRecordV1>) {
    this.store =
      typeof filePathOrStore === 'string'
        ? new ProfileControlStore(filePathOrStore, InstallationRecordV1Schema)
        : filePathOrStore
  }

  getOrCreate(): Promise<ControlMutationResult<InstallationRecordV1>> {
    if (!this.inFlight) {
      this.inFlight = this.loadOrCreate().finally(() => {
        this.inFlight = undefined
      })
    }
    return this.inFlight
  }

  private async loadOrCreate(): Promise<ControlMutationResult<InstallationRecordV1>> {
    return withProfileControlLock(this.store.path, async () => {
      const existing = await this.store.read()
      if (existing.kind === 'ok') {
        return { value: existing.value, durability: { kind: 'not-written' } }
      }
      if (existing.kind === 'corrupt') {
        throw new Error(`Installation record is corrupt at ${existing.filePath}: ${existing.error}`)
      }

      const created = InstallationRecordV1Schema.parse({
        version: 1,
        deviceInstallId: randomUUID(),
        createdAt: new Date().toISOString()
      })
      const durability = await this.store.write(created)
      return { value: created, durability }
    })
  }
}
