// ProfileAuthEpoch seals a point-in-time view of the authorization lifecycle so
// that in-flight operations (e.g. a profile switch or a credential write) can
// prove they ran against the auth state they started with. Advancing any
// generation invalidates every prior snapshot: a caller cannot accept a
// response that was produced under a superseded epoch.
//
// Forgery resistance: a snapshot carries an instance-bound seal keyed by a
// module-private symbol. Only this class mints it, so a caller cannot craft an
// object whose values would pass assertCurrent — the key is private and cannot
// be reproduced externally, and each instance uses its own seal.

const ProfileAuthSeal: unique symbol = Symbol('ProfileAuthEpoch')

export type ProfileAuthSnapshot = Readonly<{
  authEpoch: number
  profileGeneration: number
  authorizationGeneration: number
  [ProfileAuthSeal]: symbol
}>

export interface ProfileAuthEpochInitial {
  authEpoch?: number
  profileGeneration?: number
  authorizationGeneration?: number
}

export class ProfileAuthEpoch {
  private authEpoch: number
  private profileGeneration: number
  private authorizationGeneration: number
  private readonly seal: symbol = Symbol('ProfileAuthEpoch-instance')

  constructor(initial: ProfileAuthEpochInitial = {}) {
    this.authEpoch = initial.authEpoch ?? 0
    this.profileGeneration = initial.profileGeneration ?? 0
    this.authorizationGeneration = initial.authorizationGeneration ?? 0
  }

  /** Captures the current generation triple under this instance's seal. */
  snapshot(): ProfileAuthSnapshot {
    return {
      authEpoch: this.authEpoch,
      profileGeneration: this.profileGeneration,
      authorizationGeneration: this.authorizationGeneration,
      [ProfileAuthSeal]: this.seal
    }
  }

  /** Throws unless the snapshot is authentic and still matches the live epoch. */
  assertCurrent(snapshot: ProfileAuthSnapshot): void {
    if (snapshot?.[ProfileAuthSeal] !== this.seal) {
      throw new Error('ProfileAuthSnapshot is not authentic to this epoch')
    }
    if (
      snapshot.authEpoch !== this.authEpoch ||
      snapshot.profileGeneration !== this.profileGeneration ||
      snapshot.authorizationGeneration !== this.authorizationGeneration
    ) {
      throw new Error('Profile auth epoch advanced; operation snapshot is stale')
    }
  }

  /** Auth state changed (logout, re-auth, switch) — invalidates all prior snapshots. */
  advanceAuth(): void {
    this.authEpoch += 1
  }

  /** Profile data changed — invalidates all prior snapshots. */
  advanceProfile(): void {
    this.profileGeneration += 1
  }

  /** Authorization context changed — invalidates all prior snapshots. */
  advanceAuthorization(): void {
    this.authorizationGeneration += 1
  }
}
