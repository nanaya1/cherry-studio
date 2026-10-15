export interface ProfileIsolationFeatureFlagInput {
  isPackaged: boolean
  profileIsolationEnabled: boolean
  env: Readonly<Record<string, string | undefined>>
}

export function isProfileIsolationEnabled(input: ProfileIsolationFeatureFlagInput): boolean {
  if (input.isPackaged) return input.profileIsolationEnabled
  return input.profileIsolationEnabled || input.env.CS_PROFILE_ISOLATION === '1'
}
