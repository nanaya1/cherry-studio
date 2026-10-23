import type { BusinessAccessGate } from '@main/core/profiles'

export function isRetryableVerificationError(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined
  if (status !== undefined) return status === 502 || status === 503 || status === 504
  return !(error instanceof Error && /(?:401|403|token|revok|invalid credential)/i.test(error.message))
}

export interface ProfileOnlineMonitorOptions {
  gate: BusinessAccessGate
  verify: () => Promise<void>
  onBlocked: (reason: string) => void
  intervalMs?: number
}

export class ProfileOnlineMonitor {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private stopped = true
  private notified = false
  private nextVerification = 0

  constructor(private readonly options: ProfileOnlineMonitorOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.nextVerification = performance.now() + (this.options.intervalMs ?? 60_000)
    this.timer = setInterval(() => this.tick(), 250)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
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
    this.nextVerification = performance.now() + (this.options.intervalMs ?? 60_000)
    void this.options
      .verify()
      .then(
        () => {
          if (!this.stopped) gate.recordVerificationSuccess()
        },
        (error: unknown) => {
          if (!this.stopped) {
            const reason = error instanceof Error ? error.message : String(error)
            const retryable = isRetryableVerificationError(error)
            gate.recordVerificationFailure(reason, retryable)
          }
        }
      )
      .finally(() => {
        this.running = false
        this.tickIfBlocked()
      })
  }

  private tickIfBlocked(): void {
    if (!this.options.gate.isAllowed()) this.tick()
  }
}
