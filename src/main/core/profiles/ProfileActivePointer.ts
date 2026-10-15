import { withProfileControlLocks } from './ProfileControlLock'
import { type ControlMutationResult, ProfileControlStore } from './ProfileControlStore'
import { type ProfileRegistry } from './ProfileRegistry'
import { type ActiveProfilePointerV1, ActiveProfilePointerV1Schema, type ProfileRecordV1 } from './ProfileSchemas'

export type ActiveProfileReadResult =
  | { kind: 'none' }
  | { kind: 'corrupt'; filePath: string; error: string }
  | { kind: 'ok'; value: ActiveProfilePointerV1; record: ProfileRecordV1 }

export class ProfileActivePointer {
  private readonly store: ProfileControlStore<ActiveProfilePointerV1>
  private readonly filePath: string

  constructor(
    filePathOrStore: string | ProfileControlStore<ActiveProfilePointerV1>,
    private readonly registry: ProfileRegistry
  ) {
    this.filePath = typeof filePathOrStore === 'string' ? filePathOrStore : filePathOrStore.path
    this.store =
      typeof filePathOrStore === 'string'
        ? new ProfileControlStore(filePathOrStore, ActiveProfilePointerV1Schema)
        : filePathOrStore
  }

  async read(): Promise<ActiveProfileReadResult> {
    const result = await this.store.read()
    if (result.kind !== 'ok') {
      return result
    }

    try {
      const record = await this.registry.requireActivatable(result.value.profileId, result.value.identityDigest)
      return { kind: 'ok', value: result.value, record }
    } catch (error) {
      return {
        kind: 'corrupt',
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async commitPointer(
    record: ProfileRecordV1,
    operationId?: string
  ): Promise<ControlMutationResult<ActiveProfilePointerV1>> {
    return withProfileControlLocks([this.registry.controlPath, this.store.path], async () => {
      const verified = await this.registry.requireActivatable(record.profileId, record.identityDigest)
      if (
        verified.profileId !== record.profileId ||
        verified.identityDigest !== record.identityDigest ||
        verified.kind !== record.kind
      ) {
        throw new Error('Profile identity metadata mismatch between pointer record and registry')
      }

      const pointer = ActiveProfilePointerV1Schema.parse({
        version: 1,
        profileId: record.profileId,
        identityDigest: record.identityDigest,
        committedAt: new Date().toISOString(),
        ...(operationId ? { operationId } : {})
      })
      const durability = await this.store.write(pointer)
      return { value: pointer, durability }
    })
  }
}
