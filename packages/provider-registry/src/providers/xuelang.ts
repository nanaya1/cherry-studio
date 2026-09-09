import { defineProvider } from './types'

const XUELANG_GATEWAY_BASE_URL = 'https://api.xuelanglm.com/v1'

export default defineProvider({
  id: 'xuelang',
  name: '雪浪工匠',
  availableInEditions: ['global', 'cn'],
  defaultChatEndpoint: 'openai-chat-completions',
  endpointConfigs: {
    'anthropic-messages': {
      adapterFamily: 'cherryin',
      baseUrl: XUELANG_GATEWAY_BASE_URL
    },
    'google-generate-content': {
      adapterFamily: 'cherryin',
      baseUrl: XUELANG_GATEWAY_BASE_URL
    },
    'openai-responses': {
      adapterFamily: 'cherryin',
      baseUrl: XUELANG_GATEWAY_BASE_URL
    },
    'openai-chat-completions': {
      adapterFamily: 'cherryin',
      baseUrl: XUELANG_GATEWAY_BASE_URL,
      reasoningFormat: { type: 'openai-chat' }
    }
  },
  metadata: {
    website: {
      official: 'https://api.xuelanglm.com/'
    }
  },
  overrides: [
    {
      apiModelId: 'Qwen3.8-27B',
      modelId: 'qwen3-8-27b',
      name: 'Qwen3.8 27B'
    },
    {
      apiModelId: 'chemindustry',
      modelId: 'chemindustry',
      name: '化工大模型'
    }
  ]
})
