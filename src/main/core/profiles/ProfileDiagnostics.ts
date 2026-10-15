export type ProfileDiagnosticType = 'signed-out' | 'local' | 'authenticated'
export type ProfileControlState = 'not-initialized' | 'ready' | 'corrupt'

export interface ProfileDiagnostics {
  enabled: boolean
  profileType?: ProfileDiagnosticType
  profileId?: string
  dataRoot?: string
  profileRoot?: string
  controlState: ProfileControlState
}

export type ProfileDiagnosticsInput = ProfileDiagnostics

export function createProfileDiagnostics(input: ProfileDiagnosticsInput): ProfileDiagnostics {
  const { enabled, profileType, profileId, dataRoot, profileRoot, controlState } = input
  return {
    enabled,
    ...(profileType === undefined ? {} : { profileType }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(profileRoot === undefined ? {} : { profileRoot }),
    controlState
  }
}
