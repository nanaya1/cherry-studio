export type SwitchFenceState =
  | { kind: 'open' }
  | { kind: 'switching'; operationId: string }
  | { kind: 'teardown-failed'; operationId: string; reason: string }
  | { kind: 'needs-recovery'; operationId: string; reason: string }

export class SwitchFence {
  private currentState: SwitchFenceState = { kind: 'open' }

  get state(): SwitchFenceState {
    return { ...this.currentState }
  }

  beginSwitch(operationId: string): void {
    if (this.currentState.kind !== 'open') {
      throw new Error(`Profile switch fence is already closed (${this.currentState.kind})`)
    }
    this.currentState = { kind: 'switching', operationId }
  }

  markTeardownFailed(reason: string): void {
    this.currentState = { kind: 'teardown-failed', operationId: this.operationId(), reason }
  }

  markNeedsRecovery(reason: string): void {
    this.currentState = { kind: 'needs-recovery', operationId: this.operationId(), reason }
  }

  /**
   * Reopen the fence after a *successful* clean teardown (or a verified
   * same-account re-login) so the caller can start the business runtime in the
   * same process. Only valid while a switch is in progress — it closes the
   * switch cleanly rather than restoring a torn-down or failed state. A failed
   * (`teardown-failed`) or `needs-recovery` fence must reach a restart, never be
   * reopened here.
   */
  reopenAfterTeardown(): void {
    if (this.currentState.kind !== 'switching') {
      throw new Error(`reopenAfterTeardown requires an in-progress switch, not a ${this.currentState.kind} fence`)
    }
    this.currentState = { kind: 'open' }
  }

  assertWritable(): void {
    this.assertOpen('writes')
  }

  assertTaskStartAllowed(): void {
    this.assertOpen('task starts')
  }

  resetForTesting(): void {
    if (process.env.NODE_ENV !== 'test') throw new Error('Switch fence reset is test-only')
    this.currentState = { kind: 'open' }
  }

  private operationId(): string {
    if (this.currentState.kind === 'open') {
      throw new Error('Profile switch fence is not closed')
    }
    return this.currentState.operationId
  }

  private assertOpen(operation: string): void {
    if (this.currentState.kind === 'open') return
    if (this.currentState.kind === 'teardown-failed') {
      throw new Error(`Profile switch teardown failed; ${operation} remain blocked until restart`)
    }
    if (this.currentState.kind === 'needs-recovery') {
      throw new Error(`Profile switch needs recovery; ${operation} remain blocked until restart`)
    }
    throw new Error(`Profile switch is in progress; ${operation} are blocked`)
  }
}

export const profileSwitchFence = new SwitchFence()
