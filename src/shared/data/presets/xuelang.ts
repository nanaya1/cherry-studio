import { createUniqueModelId } from '@shared/data/types/model'

export const XUELANG_PROVIDER_ID = 'xuelang' as const
export const XUELANG_PROVIDER_NAME = '雪浪工匠' as const
export const XUELANG_DEFAULT_MODEL_ID = 'Qwen3.8-27B' as const
export const XUELANG_DEFAULT_PRESET_MODEL_ID = 'qwen3-8-27b' as const
export const XUELANG_DEFAULT_MODEL_NAME = 'Qwen3.8 27B' as const
export const XUELANG_DEFAULT_UNIQUE_MODEL_ID = createUniqueModelId(XUELANG_PROVIDER_ID, XUELANG_DEFAULT_MODEL_ID)

export function isManagedXuelangProviderId(providerId: string): boolean {
  return providerId === XUELANG_PROVIDER_ID
}

export function isManagedXuelangDefaultModel(providerId: string, modelId: string): boolean {
  return providerId === XUELANG_PROVIDER_ID && modelId === XUELANG_DEFAULT_MODEL_ID
}
