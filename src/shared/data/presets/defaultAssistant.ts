import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'

import { XUELANG_DEFAULT_UNIQUE_MODEL_ID } from './xuelang'

export const DEFAULT_ASSISTANT_NAME = 'MEA Cowork' as const
export const DEFAULT_ASSISTANT_EMOJI = '😀' as const
export const DEFAULT_ASSISTANT_PROMPT = '' as const

export function getDefaultAssistantNameForLocale(_locale?: string | null): string {
  return DEFAULT_ASSISTANT_NAME
}

export const DEFAULT_ASSISTANT_SEED = {
  name: DEFAULT_ASSISTANT_NAME,
  emoji: DEFAULT_ASSISTANT_EMOJI,
  prompt: DEFAULT_ASSISTANT_PROMPT,
  description: '',
  modelId: XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  settings: { ...DEFAULT_ASSISTANT_SETTINGS, mcpMode: 'auto' }
} as const
