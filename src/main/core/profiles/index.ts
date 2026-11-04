export { runAuthSessionOperation } from './AuthSessionProcess'
export { getProfileAuthSession, restoreProfileAuthSession } from './ProfileAuthRuntime'
export { BusinessAccessGate } from './BusinessAccessGate'
export { ProfileAuthEpoch } from './ProfileAuthEpoch'
export { verifyCandidateProfile, type StartupVerificationResult } from './ProfileStartupVerifier'
export { ProfileActivePointer, type ActiveProfileReadResult } from './ProfileActivePointer'
export { ProfileBootJournal, type ProfileBootJournalOptions } from './ProfileBootJournal'
export {
  isUnsupportedParentDirectoryDurabilityError,
  ProfileControlStore,
  type ControlMutationResult,
  type ControlReadResult,
  type ControlWriteResult,
  type DurabilityConfirmer
} from './ProfileControlStore'
export {
  createProfileDiagnostics,
  type ProfileControlState,
  type ProfileDiagnostics,
  type ProfileDiagnosticsInput,
  type ProfileDiagnosticType
} from './ProfileDiagnostics'
export { isProfileIsolationEnabled, type ProfileIsolationFeatureFlagInput } from './ProfileFeatureFlag'
export {
  canonicalizeProfileIdentity,
  computeIdentityDigest,
  computeProfileId,
  normalizeAuthenticatedSubject,
  type AuthenticatedAccountKind,
  type AuthenticatedAuthMode,
  type ProfileIdentity
} from './ProfileIdentity'
export { closeProfileBootstrapWindows, confirmProfileClaim, createProfileBootstrapWindow } from './ProfileBootstrapWindow'
export { ProfileInstallation } from './ProfileInstallation'
export {
  LegacyProfileAdoption,
  validateSqliteIntegrity,
  type LegacyAdoptionManifestV1,
  type SqliteIntegrityValidator
} from './LegacyProfileAdoption'
export {
  ProfileClaimService,
  type ProfileClaimAllow,
  type ProfileClaimCategory,
  type ProfileClaimPreview,
  type ProfileClaimPreviewItem
} from './ProfileClaimService'
export { ProfileCacheLifecycleService } from './ProfileCacheLifecycleService'
export {
  ProfileSensitiveDataMigrator,
  type ProfileSensitiveDataItem,
  type ProfileSensitiveDataMigrationResult
} from './ProfileSensitiveDataMigrator'
export {
  ProfileSessionService,
  type CompletedProfileAuthentication,
  type ProfileSessionServiceDependencies
} from './ProfileSessionService'
export {
  cookieToSetDetails,
  clearAllowedCookies,
  copyAllowedCookies,
  fetchCurrentUserViaSession,
  readAllowedCookies,
  resolveAuthSessionPath,
  type CookieSessionPort
} from './ProfileAuthSession'
export {
  ProfilePrebootCoordinator,
  type ProfileLaunchContext,
  type ProfileLaunchMode,
  type PendingProfileSwitch,
  type ProfilePrebootCoordinatorOptions
} from './ProfilePrebootCoordinator'
export { createProfilePaths, resolveProfileRoot, validateExistingProfilePath, type ProfilePaths } from './ProfilePaths'
export { ProfileRegistry, SIGNED_OUT_DIGEST, type ProfileAuthorizationContext } from './ProfileRegistry'
export {
  getProfileLaunchContext,
  setProfileLaunchContext,
  getLastBusinessIdentityDigest,
  shouldActivateInProcess,
  profileBusinessAccessGate
} from './ProfileRuntimeContext'
export {
  ActiveProfilePointerV1Schema,
  InstallationRecordV1Schema,
  LegacyAdoptionJournalV1Schema,
  ProfileBootJournalV1Schema,
  ProfileClaimJournalV1Schema,
  ProfileRecordV1Schema,
  ProfileRegistryV1Schema,
  ProfileSwitchJournalV1Schema,
  type ActiveProfilePointerV1,
  type InstallationRecordV1,
  type LegacyAdoptionJournalV1,
  type ProfileBootJournalV1,
  type ProfileClaimJournalV1,
  type ProfileRecordV1,
  type ProfileRegistryV1,
  type ProfileSwitchJournalV1
} from './ProfileSchemas'
export {
  ProfileSwitchCoordinator,
  type ProfileSwitchCoordinatorDependencies,
  type ProfileSwitchResult,
  type ProfileSwitchTransition
} from './ProfileSwitchCoordinator'
export { ProfileSwitchJournal, type CommitProfileSwitch, type PrepareProfileSwitch } from './ProfileSwitchJournal'
export { profileSwitchFence, SwitchFence, type SwitchFenceState } from './SwitchFence'
