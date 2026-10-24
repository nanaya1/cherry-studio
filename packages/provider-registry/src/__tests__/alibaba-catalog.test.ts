import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CREATORS } from '../creators'
import { RegistryLoader } from '../registry-loader'

const dataDir = join(fileURLToPath(import.meta.url), '..', '..', '..', 'data')
const loader = new RegistryLoader({
  models: join(dataDir, 'models.json'),
  providers: join(dataDir, 'providers.json'),
  providerModels: join(dataDir, 'provider-models.json')
})

describe('Alibaba Qwen catalog', () => {
  it('preserves Flash Next video inputs in the creator source and shipped catalog', () => {
    const creator = CREATORS.find(({ id }) => id === 'alibaba')
    const source = creator?.models?.find(({ id }) => id === 'qwen3-8-flash-next')

    for (const model of [source, loader.findModel('qwen3-8-flash-next')]) {
      expect(model?.inputModalities).toEqual(['text', 'image', 'video'])
      expect(model?.capabilities).toContain('video-recognition')
    }
  })

  it('hand-lists Qwen3.8 Flash with its documented capabilities and token limits', () => {
    const alibaba = CREATORS.find(({ id }) => id === 'alibaba')

    expect(alibaba?.models?.find(({ id }) => id === 'qwen3-8-flash')).toMatchObject({
      capabilities: expect.arrayContaining([
        'reasoning',
        'function-call',
        'image-recognition',
        'video-recognition',
        'structured-output'
      ]),
      contextWindow: 1000000,
      maxInputTokens: 991808,
      maxOutputTokens: 131072,
      name: 'Qwen3.8 Flash'
    })
    expect(loader.findModel('qwen3-8-flash')).toMatchObject({
      id: 'qwen3-8-flash',
      name: 'Qwen3.8 Flash',
      ownedBy: 'alibaba'
    })
  })

  it('registers Z-Image Turbo as a text-only Alibaba image model', () => {
    const creator = CREATORS.find(({ id }) => id === 'alibaba')

    expect(creator?.models?.find(({ id }) => id === 'z-image-turbo')).toMatchObject({
      capabilities: ['image-generation'],
      inputModalities: ['text'],
      outputModalities: ['image']
    })
    expect(loader.findModel('z-image-turbo')).toMatchObject({
      id: 'z-image-turbo',
      name: 'Z-Image Turbo',
      ownedBy: 'alibaba'
    })
    expect(loader.findOverride('dashscope', 'z-image-turbo')).toMatchObject({
      apiModelId: 'z-image-turbo',
      modelId: 'z-image-turbo',
      imageGeneration: {
        modes: {
          generate: {
            vendorTransport: {
              endpoint: '/api/v1/services/aigc/multimodal-generation/generation',
              isSync: true
            }
          }
        }
      }
    })
  })

  it('registers Qwen Image 2.1 Pro in the creator and generated catalog', () => {
    const creator = CREATORS.find(({ id }) => id === 'alibaba')

    expect(creator?.models?.find(({ id }) => id === 'qwen-image-2-1-pro')).toMatchObject({
      capabilities: expect.arrayContaining(['image-recognition', 'image-generation']),
      inputModalities: ['text', 'image'],
      outputModalities: ['image']
    })
    expect(loader.findModel('qwen-image-2-1-pro')).toMatchObject({
      id: 'qwen-image-2-1-pro',
      name: 'Qwen Image 2.1 Pro',
      ownedBy: 'alibaba'
    })
  })

  it('maps DashScope qwen-image-2.1-pro to the native sync multimodal transport', () => {
    expect(loader.findOverride('dashscope', 'qwen-image-2.1-pro')).toMatchObject({
      apiModelId: 'qwen-image-2.1-pro',
      modelId: 'qwen-image-2-1-pro',
      imageGeneration: {
        modes: {
          edit: {
            vendorTransport: {
              endpoint: '/api/v1/services/aigc/multimodal-generation/generation',
              isSync: true
            }
          },
          generate: {
            vendorTransport: {
              endpoint: '/api/v1/services/aigc/multimodal-generation/generation',
              isSync: true
            }
          }
        }
      }
    })
  })

  it('enables registry supplementation for DashScope native image models', () => {
    expect(loader.findProvider('dashscope')).toMatchObject({ supplementModelsFromRegistry: true })
  })

  it('maps DashScope to qwen3.8-flash with the Qwen3.8 effort contract', () => {
    expect(loader.findOverride('dashscope', 'qwen3.8-flash')).toMatchObject({
      apiModelId: 'qwen3.8-flash',
      endpointTypes: ['openai-responses', 'openai-chat-completions'],
      modelId: 'qwen3-8-flash',
      reasoningContracts: {
        'openai-chat-completions': {
          support: {
            controls: [{ default: 'xhigh', kind: 'effort', values: ['none', 'low', 'medium', 'xhigh'] }],
            thinkingTokenLimits: { min: 0, max: 262144 }
          }
        },
        'openai-responses': {
          support: {
            controls: [
              { default: 'xhigh', kind: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
            ]
          }
        }
      }
    })
  })
})
