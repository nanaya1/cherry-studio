// MEA:profile-online-login A verified process keeps authority until explicit invalidity or a user transition.
// Verification health and the last successful check time never impose an authorization deadline.

export type BusinessAccessState =
  | { kind: 'verifying' }
  // | { kind: 'verified-online'; expiresAt: number }
  | { kind: 'verified-online'; checkedAt: number }
  | { kind: 'blocked'; reason: string; retryable?: boolean }
  | { kind: 'restart-required'; reason: string }

export interface BusinessAccessGateOptions {
  clock: () => number
  /** @deprecated No authorization deadline is imposed; retained for existing callers. */
  verificationWindowMs?: number
}

export class BusinessAccessGate {
  private readonly clock: () => number
  // private readonly verificationWindowMs: number
  private currentState: BusinessAccessState = { kind: 'verifying' }
  // private verificationDeadline: number | undefined

  constructor(options: BusinessAccessGateOptions) {
    this.clock = options.clock
    // this.verificationWindowMs = options.verificationWindowMs
  }

  get state(): BusinessAccessState {
    return { ...this.currentState }
  }

  /** Begin (or re-begin) an online verification. Retryable blocks may recover. */
  beginVerification(): void {
    if (
      this.currentState.kind === 'verifying' ||
      // this.currentState.kind === 'verified-online' ||
      (this.currentState.kind === 'blocked' && this.currentState.retryable)
    ) {
      this.currentState = { kind: 'verifying' }
    }
  }

  /** Record a successful online check without clearing a definitive block. */
  recordVerificationSuccess(): void {
    this.enforceDeadline()
    if (this.currentState.kind === 'blocked' || this.currentState.kind === 'restart-required') return
    // this.currentState = { kind: 'verified-online', expiresAt: this.clock() + this.verificationWindowMs }
    // this.verificationDeadline = this.clock() + this.verificationWindowMs
    // this.currentState = { kind: 'verified-online', expiresAt: this.verificationDeadline }
    this.currentState = { kind: 'verified-online', checkedAt: this.clock() }
  }

  /** Only definitive failures block; temporary failures retain the last verified authority. */
  recordVerificationFailure(reason: string, retryable = false): void {
    if (this.currentState.kind === 'blocked' || this.currentState.kind === 'restart-required') return
    // MEA:profile-verification-network-tolerance Temporary unavailability does not revoke this process's last verified authority.
    if (retryable) return
    this.currentState = { kind: 'blocked', reason, ...(retryable ? { retryable: true } : {}) }
  }

  /** Compatibility hook for existing callers; elapsed time alone cannot revoke authority. */
  enforceDeadline(): void {
    // if (this.currentState.kind === 'verified-online' && this.clock() >= this.currentState.expiresAt) {
    // MEA:profile-verification-network-tolerance Time passing is not evidence of account revocation.
    /*
    if (
      (this.currentState.kind === 'verified-online' || this.currentState.kind === 'verifying') &&
      this.verificationDeadline !== undefined &&
      this.clock() >= this.verificationDeadline
    ) {
      this.currentState = { kind: 'blocked', reason: 'verification window expired' }
    }
    */
  }

  /** Recover from blocked to the durable restart-required state. Never to verified-online. */
  recoverFromBlocked(): void {
    if (this.currentState.kind !== 'blocked') return
    this.currentState = { kind: 'restart-required', reason: 'manual recovery from blocked' }
  }

  isAllowed(): boolean {
    this.enforceDeadline()
    // return this.currentState.kind === 'verified-online' && this.clock() < this.currentState.expiresAt
    return this.currentState.kind === 'verified-online'
  }

  assertReadable(): void {
    this.assertAllowed('reads')
  }

  assertWritable(): void {
    this.assertAllowed('writes')
  }

  private assertAllowed(operation: string): void {
    if (this.isAllowed()) return
    switch (this.currentState.kind) {
      case 'verifying':
        throw new Error(`Business access is verifying; ${operation} are blocked`)
      case 'blocked':
        throw new Error(`Business access is blocked; ${operation} are blocked`)
      case 'restart-required':
        throw new Error(`Business access requires restart; ${operation} are blocked`)
      case 'verified-online':
        throw new Error(`Verification window expired; ${operation} are blocked`)
    }
  }
}
