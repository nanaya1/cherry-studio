import { BusinessAccessGate } from './BusinessAccessGate'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'

export let profileBusinessAccessGate = new BusinessAccessGate({
  clock: () => performance.now(),
  verificationWindowMs: 5 * 60_000
})

let launchContext: ProfileLaunchContext | undefined

/**
 * Identity digest of the last account whose business runtime successfully
 * started *in this process*. Independent of the current launch context (which is
 * `signed-out` while a login window is open, so it must NOT be used to decide
 * activation). A cold start that never launched business leaves this `null`,
 * which lets the first signed-in account activate in-process.
 */
let lastBusinessIdentityDigest: string | null = null

export function setProfileLaunchContext(context: ProfileLaunchContext | undefined): void {
  launchContext = context
  profileBusinessAccessGate = new BusinessAccessGate({
    clock: () => performance.now(),
    verificationWindowMs: 5 * 60_000
  })
  if (context?.mode === 'business') {
    lastBusinessIdentityDigest = context.identityDigest
  }
}

export function getProfileLaunchContext(): ProfileLaunchContext | undefined {
  return launchContext
}

export function getLastBusinessIdentityDigest(): string | null {
  return lastBusinessIdentityDigest
}

/**
 * Decide whether the just-authenticated `record` should open its business
 * runtime in the current process (no relaunch). A cold start (`null` last
 * identity) activates any first account; afterwards only the same identity may
 * reuse the process — a different identity forces a relaunch so a clean,
 * account-isolated runtime is built from scratch.
 */
export function shouldActivateInProcess(
  record: { kind: string; identityDigest: string },
  lastBusinessIdentityDigest: string | null
): boolean {
  if (record.kind !== 'authenticated') return false
  if (lastBusinessIdentityDigest === null) return true
  return record.identityDigest === lastBusinessIdentityDigest
}
