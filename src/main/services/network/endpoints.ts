import { resolveCherryCloudApiOrigin } from '@main/services/cherryCloud/CherryCloudService'
import { DIAGNOSTIC_UPLOAD_URL } from '@main/services/diagnostics'
import { resolveRegistryBaseUrl } from '@main/services/ProviderRegistryUpdaterService'
// import { RELEASE_HISTORY_URL } from '@main/services/AppUpdaterService'
import { ENABLE_CHERRY_OFFICIAL_SERVICES } from '@shared/utils/constants'

import type { NetworkEndpoint } from './types'

/** Built-in URLs use their owning services' resolution, including the updater's country detection. */
export async function builtinEndpoints(): Promise<readonly NetworkEndpoint[]> {
  if (!ENABLE_CHERRY_OFFICIAL_SERVICES) return []
  return [
    // Cherry 官方 release-history 已停用。
    // { id: 'update', url: RELEASE_HISTORY_URL },
    { id: 'registry', url: `${await resolveRegistryBaseUrl()}/manifest.json` },
    { id: 'cloud', url: resolveCherryCloudApiOrigin() },
    { id: 'diagnostics', url: DIAGNOSTIC_UPLOAD_URL }
  ]
}
