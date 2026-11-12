import type { Model } from '@shared/data/types/model'
import { isFunctionCallingModel } from '@shared/utils/model'

export type IndustrialVideoModelStatus = 'supported' | 'unverified' | 'failed'

export function getIndustrialVideoModelStatus(providerId: string, modelId: string): IndustrialVideoModelStatus {
  return providerId === 'c3f07f02-f6dc-4110-8b22-8c77d9174e17' && modelId === 'chemellm_agent' ? 'failed' : 'unverified'
}

export function supportsIndustrialVideoTools(model: Model): boolean {
  return Boolean(model.capabilities && isFunctionCallingModel(model))
}
