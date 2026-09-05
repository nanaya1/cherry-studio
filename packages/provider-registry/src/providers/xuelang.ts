import { openaiCompatible } from './types'

export default openaiCompatible({
  id: 'xuelang',
  name: '雪浪工匠',
  baseUrl: 'http://36.150.116.247:8069/v1',
  availableInEditions: ['global', 'cn'],
  authOptional: true,
  website: {
    official: 'http://36.150.116.247:8069'
  },
  overrides: [
    {
      apiModelId: 'Qwen3.8-27B',
      modelId: 'qwen3-8-27b',
      name: 'Qwen3.8 27B'
    },
    {
      apiModelId: 'Qwen3.6-35B-A3B',
      modelId: 'qwen3-6-35b-a3b',
      name: 'Qwen3.6 35B A3B'
    }
  ]
})
