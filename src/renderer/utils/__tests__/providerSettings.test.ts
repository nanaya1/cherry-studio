import { CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import { LOCAL_EMBEDDING_PROVIDER_ID } from '@shared/data/presets/localEmbedding'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import type { Provider } from '@shared/data/types/provider'
import { describe, expect, it } from 'vitest'

import { isProviderSettingsListVisibleProvider } from '../providerSettings'

// Canonical preset rows seed with presetProviderId === id (presetProviderSeeder),
// derived instances keep the preset id, user-created rows have no preset linkage.
const presetProvider = (id: string): Provider => ({ id, presetProviderId: id }) as Provider
const presetInstance = (id: string, presetProviderId: string): Provider => ({ id, presetProviderId }) as Provider
const customProvider = (id: string): Provider => ({ id }) as Provider

describe('isProviderSettingsListVisibleProvider', () => {
  it('keeps the whitelisted editable presets visible', () => {
    expect(isProviderSettingsListVisibleProvider(presetProvider('deepseek'))).toBe(true)
    expect(isProviderSettingsListVisibleProvider(presetProvider('zhipu'))).toBe(true)
  })

  it('hides built-in presets outside the whitelist', () => {
    expect(isProviderSettingsListVisibleProvider(presetProvider('openai'))).toBe(false)
    expect(isProviderSettingsListVisibleProvider(presetProvider('anthropic'))).toBe(false)
  })

  it('keeps instances derived from a whitelisted preset visible', () => {
    expect(isProviderSettingsListVisibleProvider(presetInstance('my-deepseek', 'deepseek'))).toBe(true)
  })

  it('hides instances derived from a non-whitelisted preset', () => {
    expect(isProviderSettingsListVisibleProvider(presetInstance('my-openai', 'openai'))).toBe(false)
  })

  it('keeps user-created providers visible', () => {
    expect(isProviderSettingsListVisibleProvider(customProvider('my-provider'))).toBe(true)
  })

  it('hides the internal local-embedding provider from the management list', () => {
    expect(isProviderSettingsListVisibleProvider(customProvider(LOCAL_EMBEDDING_PROVIDER_ID))).toBe(false)
  })

  it('hides managed providers', () => {
    expect(isProviderSettingsListVisibleProvider(presetProvider(CHERRYAI_PROVIDER_ID))).toBe(false)
    expect(isProviderSettingsListVisibleProvider(presetProvider(XUELANG_PROVIDER_ID))).toBe(false)
  })
})
