import type { ServiceConstructor } from '@main/core/lifecycle'
import type { ProfileLaunchMode } from '@main/core/profiles'

export const bootstrapServiceList: ServiceConstructor[] = []

export function getServiceListForProfileMode(
  mode: ProfileLaunchMode,
  businessServiceList: ServiceConstructor[]
): ServiceConstructor[] {
  if (mode !== 'business') return [...bootstrapServiceList]
  return [...bootstrapServiceList, ...businessServiceList]
}

export function serviceNameList(serviceList: ServiceConstructor[]): string[] {
  return serviceList.map((service) => service.name)
}
