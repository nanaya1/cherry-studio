import type { BusinessAccessGate } from '@main/core/profiles'

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
      if (!this.notified) {
        this.notified = true
        onBlocked('Online verification is blocked; restart is required')
      }
      return
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
          if (!this.stopped) gate.recordVerificationFailure(error instanceof Error ? error.message : String(error))
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
