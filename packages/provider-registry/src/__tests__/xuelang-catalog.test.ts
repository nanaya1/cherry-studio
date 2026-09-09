import { describe, expect, it } from 'vitest'

import { PROVIDERS } from '../providers'

// 雪浪工匠 rides the CherryIN gateway stack: same adapterFamily, same four
// endpoints, different host. These tests pin that contract so a future edit
// cannot silently demote xuelang back to a plain openai-compatible provider.
describe('xuelang provider registry entry', () => {
  const provider = PROVIDERS.find((p) => p.id === 'xuelang')
  if (!provider) throw new Error('Missing provider: xuelang')

  it('serves the same four gateway endpoints as cherryin', () => {
    expect(Object.keys(provider.endpointConfigs ?? {}).sort()).toEqual(
      ['anthropic-messages', 'google-generate-content', 'openai-chat-completions', 'openai-responses'].sort()
    )
  })

  it.each([
    'anthropic-messages',
    'google-generate-content',
    'openai-responses',
    'openai-chat-completions'
  ] as const)('routes %s through the cherryin adapterFamily', (endpoint) => {
    expect(provider.endpointConfigs?.[endpoint]?.adapterFamily).toBe('cherryin')
  })

  it('points every endpoint at the xuelang gateway host', () => {
    for (const config of Object.values(provider.endpointConfigs ?? {})) {
      expect(config.baseUrl).toBe('https://api.xuelanglm.com/v1')
    }
  })

  it('defaults chat to openai-chat-completions with the openai-chat reasoning format', () => {
    expect(provider.defaultChatEndpoint).toBe('openai-chat-completions')
    expect(provider.endpointConfigs?.['openai-chat-completions']?.reasoningFormat?.type).toBe('openai-chat')
  })

  it('keeps serving the configured models in both editions', () => {
    expect(provider.availableInEditions).toEqual(['global', 'cn'])
    expect(provider.overrides?.map((o) => o.modelId)).toEqual(['qwen3-8-27b', 'chemindustry'])
  })
})
