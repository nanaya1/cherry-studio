import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import { orgStateStore } from '@main/enterprise/OrgStateStore'
import { copilotService } from '@main/services/CopilotService'

@Injectable('ProfileCacheLifecycleService')
@ServicePhase(Phase.BeforeReady)
export class ProfileCacheLifecycleService extends BaseService {
  protected onStop(): void {
    copilotService.resetProfileCache()
    orgStateStore.resetProfileCache()
    providerRegistryService.clearCache()
  }
}
