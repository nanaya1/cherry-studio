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
 * so the first signed-in account must relaunch with its isolated paths.
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
 * runtime in the current process (no relaunch). Only the same identity may
 * reuse a previously started business runtime. First login and different
 * identities relaunch so account paths are applied before Electron sessions
 * and business services are created.
 */
export function shouldActivateInProcess(
  record: { kind: string; identityDigest: string },
  lastBusinessIdentityDigest: string | null
): boolean {
  if (record.kind !== 'authenticated') return false
  // 首次登录须在创建 Electron session 前设置账号路径，交由冷启动完成。
  // if (lastBusinessIdentityDigest === null) return true
  if (lastBusinessIdentityDigest === null) return false
  return record.identityDigest === lastBusinessIdentityDigest
}
