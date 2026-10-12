import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())

import { ChatConversationControls } from '../ChatConversationControls'

// MEA:resource-icons 防止显式头像或名称首字符重新成为助手图标。
describe('MEA resource-icons: assistant trigger', () => {
  it.each([
    ['Helper', false],
    ['🤖 Helper', false],
    ['Helper', true],
    ['🤖 Helper', true]
  ] as const)('保留名称 %s 并隐藏助手头像（紧凑模式：%s）', (assistantName, iconOnly) => {
    render(
      <ChatConversationControls
        assistantId="assistant-1"
        assistantName={assistantName}
        {...{ assistantEmoji: '🤖' }}
        providers={[]}
        mentionedModels={[]}
        mentionedModelSelectorValue={[]}
        lockedMentionedModels={[]}
        mentionedModelMultiSelectMode={false}
        shouldAutoSelectCreatedAssistant={false}
        selectModelLabel="Model"
        showModelControl={false}
        assistantTriggerAction="edit"
        side="bottom"
        iconOnly={iconOnly}
        onAssistantChange={vi.fn()}
        onModelSelect={vi.fn()}
        onMentionedModelsSelect={vi.fn()}
        onMentionedModelMultiSelectModeChange={vi.fn()}
        onMentionedModelSelectorRestore={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', { name: new RegExp(assistantName) })
    expect(within(trigger).getByText(assistantName)).toBeInTheDocument()
    expect(trigger.querySelectorAll('svg.lucide-bot')).toHaveLength(iconOnly ? 1 : 0)
    expect(within(trigger).queryByText('🤖', { exact: true })).not.toBeInTheDocument()
  })
})
