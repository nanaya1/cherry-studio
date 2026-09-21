import { defineProvider } from './types'

export default defineProvider({
  id: 'tokendance',
  name: 'TokenDance',
  availableInEditions: ['global', 'cn'],
  defaultChatEndpoint: 'openai-chat-completions',
  endpointConfigs: {
    'anthropic-messages': {
      adapterFamily: 'anthropic',
      baseUrl: 'https://tokendance.space/gateway'
    },
    'google-generate-content': {
      adapterFamily: 'google',
      baseUrl: 'https://tokendance.space/gateway'
    },
    'openai-chat-completions': {
      adapterFamily: 'openai-compatible',
      baseUrl: 'https://tokendance.space/gateway',
      modelsApiUrls: { default: 'https://tokendance.space/gateway/v1/models' }
    },
    'openai-embeddings': {
      adapterFamily: 'openai-compatible',
      baseUrl: 'https://tokendance.space/gateway'
    },
    'openai-image-generation': {
      adapterFamily: 'openai-compatible',
      baseUrl: 'https://tokendance.space/gateway'
    },
    'openai-responses': {
      adapterFamily: 'openai',
      baseUrl: 'https://tokendance.space/gateway'
    }
  },
  metadata: {
    website: {
      apiKey: 'https://tokendance.space/keys',
      // 「文档」入口暂时隐藏：目标路径使用 Cherry Studio 品牌。恢复时取消下方注释。
      // docs: 'https://tokendance.space/docs/cherry-studio',
      models: 'https://tokendance.space/models',
      official: 'https://tokendance.space'
    }
  }
})
