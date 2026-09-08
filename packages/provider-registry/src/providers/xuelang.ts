import { openaiCompatible } from './types'

export default openaiCompatible({
  id: 'xuelang',
  name: '雪浪工匠',
  baseUrl: 'https://api.xuelanglm.com/v1',
  availableInEditions: ['global', 'cn'],
  website: {
    official: 'https://api.xuelanglm.com/'
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
