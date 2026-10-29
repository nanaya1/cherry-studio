// BusinessAccessGate is a pure state machine for online-verification-gated
// business access. It is driven entirely by the caller (no internal timer): an
// external scheduler invokes beginVerification/recordVerification* and
// enforceDeadline. The clock is injected so tests are deterministic and the
// deadline uses a monotonic source that wall-clock jumps cannot defeat.
//
// Invariants enforced by the transitions:
//  - reads and writes are blocked in every state except a live verified-online.
//  - a normal re-verify (beginVerification → recordVerificationSuccess) only
//    refreshes the deadline; it never unblocks a durable state.
//  - recovery from blocked reaches restart-required and nothing further — a
//    successful verification while blocked/restart-required is ignored, so a
//    durable block can never silently become verified-online.
//  - credential cleanup (logout/clear) is deliberately NOT part of this API.

export type BusinessAccessState =
  | { kind: 'verifying' }
  | { kind: 'verified-online'; expiresAt: number }
  | { kind: 'blocked'; reason: string; retryable?: boolean }
  | { kind: 'restart-required'; reason: string }

export interface BusinessAccessGateOptions {
  clock: () => number
  verificationWindowMs: number
}

export class BusinessAccessGate {
  private readonly clock: () => number
  private readonly verificationWindowMs: number
  private currentState: BusinessAccessState = { kind: 'verifying' }
  private verificationDeadline: number | undefined

  constructor(options: BusinessAccessGateOptions) {
    this.clock = options.clock
    this.verificationWindowMs = options.verificationWindowMs
  }

  get state(): BusinessAccessState {
    return { ...this.currentState }
  }

  /** Begin (or re-begin) an online verification. Retryable blocks may recover. */
  beginVerification(): void {
    if (
      this.currentState.kind === 'verifying' ||
      this.currentState.kind === 'verified-online' ||
      (this.currentState.kind === 'blocked' && this.currentState.retryable)
    ) {
      this.currentState = { kind: 'verifying' }
    }
  }

  /** Record a successful verification: enter or refresh verified-online. Ignored if durable-blocked. */
  recordVerificationSuccess(): void {
    this.enforceDeadline()
    if (this.currentState.kind === 'blocked' || this.currentState.kind === 'restart-required') return
    // this.currentState = { kind: 'verified-online', expiresAt: this.clock() + this.verificationWindowMs }
    this.verificationDeadline = this.clock() + this.verificationWindowMs
    this.currentState = { kind: 'verified-online', expiresAt: this.verificationDeadline }
  }

  /** Record a failed verification: block. Ignored if already durable-blocked. */
  recordVerificationFailure(reason: string, retryable = false): void {
    this.enforceDeadline()
    if (this.currentState.kind === 'blocked' || this.currentState.kind === 'restart-required') return
    // Temporary failures cannot shorten or extend a previously verified lease.
    if (retryable && this.isAllowed()) return
    this.currentState = { kind: 'blocked', reason, ...(retryable ? { retryable: true } : {}) }
  }

  /** Apply expiry: verified-online past its deadline becomes blocked. */
  enforceDeadline(): void {
    // if (this.currentState.kind === 'verified-online' && this.clock() >= this.currentState.expiresAt) {
    if (
      (this.currentState.kind === 'verified-online' || this.currentState.kind === 'verifying') &&
      this.verificationDeadline !== undefined &&
      this.clock() >= this.verificationDeadline
    ) {
      this.currentState = { kind: 'blocked', reason: 'verification window expired' }
    }
  }

  /** Recover from blocked to the durable restart-required state. Never to verified-online. */
  recoverFromBlocked(): void {
    if (this.currentState.kind !== 'blocked') return
    this.currentState = { kind: 'restart-required', reason: 'manual recovery from blocked' }
  }

  isAllowed(): boolean {
    this.enforceDeadline()
    return this.currentState.kind === 'verified-online' && this.clock() < this.currentState.expiresAt
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
