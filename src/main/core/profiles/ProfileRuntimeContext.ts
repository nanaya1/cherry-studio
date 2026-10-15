import { BusinessAccessGate } from './BusinessAccessGate'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'

export let profileBusinessAccessGate = new BusinessAccessGate({
  clock: () => performance.now(),
  verificationWindowMs: 5 * 60_000
})

let launchContext: ProfileLaunchContext | undefined

export function setProfileLaunchContext(context: ProfileLaunchContext | undefined): void {
  launchContext = context
  profileBusinessAccessGate = new BusinessAccessGate({
    clock: () => performance.now(),
    verificationWindowMs: 5 * 60_000
  })
}

export function getProfileLaunchContext(): ProfileLaunchContext | undefined {
  return launchContext
}
