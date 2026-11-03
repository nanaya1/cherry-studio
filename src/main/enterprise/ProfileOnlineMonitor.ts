import type { BusinessAccessGate } from '@main/core/profiles'

import { isDefinitiveVerificationError, VerificationError } from './verification'

export function isRetryableVerificationError(error: unknown): boolean {
  // MEA:profile-verification-network-tolerance Text and HTTP errors alone never prove global credential invalidity.
  /*
  const status =
    typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined
  if (status !== undefined) return status === 502 || status === 503 || status === 504
  return !(error instanceof Error && /(?:401|403|token|revok|invalid credential)/i.test(error.message))
  */
  return !isDefinitiveVerificationError(error)
}

export interface ProfileOnlineMonitorOptions {
  gate: BusinessAccessGate
  verify: () => Promise<void>
  onBlocked: (reason: string) => void
  intervalMs?: number
  random?: () => number
}

export class ProfileOnlineMonitor {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private stopped = true
  private notified = false
  private nextVerification = 0
  private failures = 0
  private epoch = 0

  constructor(private readonly options: ProfileOnlineMonitorOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    ++this.epoch
    this.failures = 0
    this.running = false
    this.notified = false
    this.nextVerification = performance.now() + (this.options.intervalMs ?? 60_000)
    this.timer = setInterval(() => this.tick(), 250)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    ++this.epoch
    clearInterval(this.timer)
    this.timer = undefined
  }

  private tick(): void {
    if (this.stopped) return
    const { gate, onBlocked } = this.options
    gate.enforceDeadline()
    if (!gate.isAllowed()) {
      if (gate.state.kind === 'blocked' && gate.state.retryable) {
        gate.beginVerification()
      } else if (gate.state.kind !== 'verifying') {
        if (!this.notified) {
          this.notified = true
          onBlocked('Online verification is blocked; restart is required')
        }
        return
      }
    }
    if (this.running || performance.now() < this.nextVerification) return
    this.running = true
    const epoch = this.epoch
    void this.options
      .verify()
      .then(
        () => {
          if (this.stopped || epoch !== this.epoch) return
          gate.recordVerificationSuccess()
          this.failures = 0
          this.nextVerification = performance.now() + (this.options.intervalMs ?? 60_000)
        },
        (error: unknown) => {
          if (this.stopped || epoch !== this.epoch) return
          const reason = error instanceof Error ? error.message : String(error)
          const retryable = isRetryableVerificationError(error)
          gate.recordVerificationFailure(reason, retryable)
          const delay = [2000, 5000, 10_000, 30_000][Math.min(this.failures++, 3)]
          const jitter = 0.9 + (this.options.random ?? Math.random)() * 0.2
          const retryAfter = error instanceof VerificationError ? (error.evidence.retryAfterMs ?? 0) : 0
          this.nextVerification = performance.now() + Math.max(Math.round(delay * jitter), retryAfter)
        }
      )
      .finally(() => {
        if (this.stopped || epoch !== this.epoch) return
        this.running = false
        this.tickIfBlocked()
      })
  }

  private tickIfBlocked(): void {
    if (!this.options.gate.isAllowed()) this.tick()
  }
}
