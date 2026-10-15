import { type ControlWriteResult, ProfileControlStore } from './ProfileControlStore'
import { type ProfileBootJournalV1, ProfileBootJournalV1Schema } from './ProfileSchemas'

export interface ProfileBootJournalOptions {
  failureThreshold?: number
  now?: () => Date
}

export type ProfileBootRecoveryDecision =
  | { recover: false; profileId: string }
  | { recover: true; profileId: 'signed-out' }

export class ProfileBootJournal {
  private readonly store: ProfileControlStore<ProfileBootJournalV1>
  private readonly failureThreshold: number
  private readonly now: () => Date

  constructor(filePath: string, options: ProfileBootJournalOptions = {}) {
    this.store = new ProfileControlStore(filePath, ProfileBootJournalV1Schema)
    this.failureThreshold = options.failureThreshold ?? 2
    this.now = options.now ?? (() => new Date())
  }

  get path(): string {
    return this.store.path
  }

  async read(): Promise<ProfileBootJournalV1> {
    const result = await this.store.read()
    if (result.kind === 'none') return this.emptyState()
    if (result.kind === 'corrupt') {
      throw new Error(`Profile boot journal is corrupt at ${result.filePath}: ${result.error}`)
    }
    return result.value
  }

  async beginAttempt(profileId: string): Promise<ControlWriteResult> {
    const state = await this.read()
    return this.store.write({
      ...state,
      failureCount: state.failureCount + (state.attempt?.status === 'started' ? 1 : 0),
      attempt: {
        number: (state.attempt?.number ?? 0) + 1,
        profileId,
        status: 'started',
        startedAt: this.now().toISOString()
      }
    })
  }

  async recordFailure(profileId: string): Promise<ControlWriteResult> {
    const state = await this.requireActiveAttempt(profileId)
    return this.store.write({
      ...state,
      failureCount: state.failureCount + 1,
      attempt: {
        ...state.attempt,
        status: 'failed',
        completedAt: this.now().toISOString()
      }
    })
  }

  async recordSuccess(profileId: string): Promise<ControlWriteResult> {
    const state = await this.requireActiveAttempt(profileId)
    return this.store.write({
      ...state,
      failureCount: 0,
      lastKnownGood: profileId,
      attempt: {
        ...state.attempt,
        status: 'succeeded',
        completedAt: this.now().toISOString()
      }
    })
  }

  async resetAfterAuthentication(): Promise<ControlWriteResult> {
    const state = await this.read()
    return this.store.write({
      version: 1,
      failureCount: 0,
      ...(state.lastKnownGood ? { lastKnownGood: state.lastKnownGood } : {})
    })
  }

  async getRecoveryDecision(profileId: string): Promise<ProfileBootRecoveryDecision> {
    try {
      const state = await this.read()
      if (state.failureCount >= this.failureThreshold) return { recover: true, profileId: 'signed-out' }
      return { recover: false, profileId }
    } catch {
      return { recover: true, profileId: 'signed-out' }
    }
  }

  private emptyState(): ProfileBootJournalV1 {
    return { version: 1, failureCount: 0 }
  }

  private async requireActiveAttempt(
    profileId: string
  ): Promise<ProfileBootJournalV1 & { attempt: NonNullable<ProfileBootJournalV1['attempt']> }> {
    const state = await this.read()
    if (!state.attempt || state.attempt.profileId !== profileId || state.attempt.status !== 'started') {
      throw new Error(`No active boot attempt for profile ${profileId}`)
    }
    return state as ProfileBootJournalV1 & { attempt: NonNullable<ProfileBootJournalV1['attempt']> }
  }
}
