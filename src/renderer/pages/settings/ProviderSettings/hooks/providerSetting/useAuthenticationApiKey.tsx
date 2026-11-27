import { createContext, use } from 'react'

import type { ApiKeyState } from './useProviderApiKey'

const ApiKeyContext = createContext<ApiKeyState | null>(null)

export const ApiKeyProvider = ApiKeyContext.Provider

export function useAuthenticationApiKey(): ApiKeyState
export function useAuthenticationApiKey(options: { managed: boolean }): ApiKeyState | null
export function useAuthenticationApiKey(options?: { managed: boolean }) {
  const value = use(ApiKeyContext)
  if (options?.managed) return null

  if (!value) {
    throw new Error('useAuthenticationApiKey must be used within ApiKeyProvider')
  }

  return value
}
