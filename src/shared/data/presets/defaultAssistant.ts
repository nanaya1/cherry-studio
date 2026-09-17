import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'

export const DEFAULT_ASSISTANT_NAME = 'MEA Cowork' as const
export const DEFAULT_ASSISTANT_EMOJI = '😀' as const
export const DEFAULT_ASSISTANT_PROMPT =
  '为制造业打造专属的「AI总工程师」\n\n工匠 Cowork 是雪浪云为制造业工程师打造的 AI 工作台。说出设计、制造、运维中的工程要求或难题，它会理解任务、组织执行，并交付可审核的完整成果。依托雪浪 MEM 工匠大模型、雪浪 OS 数字底座与雪浪 Mind 智能终端，连接研发设计与生产制造生态，成为你的智能制造好帮手' as const

export function getDefaultAssistantNameForLocale(_locale?: string | null): string {
  return DEFAULT_ASSISTANT_NAME
}

export const DEFAULT_ASSISTANT_SEED = {
  name: DEFAULT_ASSISTANT_NAME,
  emoji: DEFAULT_ASSISTANT_EMOJI,
  prompt: DEFAULT_ASSISTANT_PROMPT,
  description: '',
  settings: { ...DEFAULT_ASSISTANT_SETTINGS, mcpMode: 'auto' }
} as const
