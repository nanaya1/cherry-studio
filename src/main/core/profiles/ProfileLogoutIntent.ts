import * as z from 'zod'

import { withProfileControlLock } from './ProfileControlLock'
import { ProfileControlStore } from './ProfileControlStore'

const logoutIntentSchema = z
  .strictObject({
    version: z.literal(1),
    operationId: z.uuid(),
    sourceProfileId: z.union([z.literal('signed-out'), z.string().regex(/^[a-f0-9]{32}$/)])
  })
  .nullable()

export class ProfileLogoutIntent {
  private readonly store: ProfileControlStore<z.infer<typeof logoutIntentSchema>>

  constructor(filePath: string) {
    this.store = new ProfileControlStore(filePath, logoutIntentSchema)
  }

  read() {
    return this.store.read()
  }

  async begin(sourceProfileId: string, operationId: string): Promise<void> {
    await withProfileControlLock(this.store.path, async () => {
      const existing = await this.store.read()
      if (existing.kind === 'corrupt') throw new Error('Logout intent is corrupt')
      if (existing.kind === 'ok' && existing.value) {
        if (existing.value.sourceProfileId !== sourceProfileId) throw new Error('Another profile logout is pending')
      }
      const result = await this.store.write(
        existing.kind === 'ok' && existing.value ? existing.value : { version: 1, sourceProfileId, operationId }
      )
      if (result.kind !== 'committed-confirmed') throw new Error('Logout intent durability is unknown')
    })
  }

  async complete(): Promise<void> {
    const result = await this.store.write(null)
    if (result.kind !== 'committed-confirmed') throw new Error('Logout completion durability is unknown')
  }
}
