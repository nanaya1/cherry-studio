import { usePreference } from '@data/hooks/usePreference'
import { ENABLE_CHERRY_OFFICIAL_SERVICES, LATEST_PRIVACY_POLICY_VERSION } from '@shared/utils/constants'

/** Whether the user must acknowledge the latest privacy policy before continuing. */
export function useIsPrivacyUpdateRequired(): boolean {
  const [policyVersion] = usePreference('app.privacy.policy_version')
  const [dataCollectionEnabled] = usePreference('app.privacy.data_collection.enabled')
  return ENABLE_CHERRY_OFFICIAL_SERVICES && dataCollectionEnabled && policyVersion !== LATEST_PRIVACY_POLICY_VERSION
}
