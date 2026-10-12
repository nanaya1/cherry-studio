import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentEntity } from '@shared/data/types/agent'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())

import { AgentConversationControls } from '../AgentConversationControls'

afterEach(cleanup)

// MEA:resource-icons 防止智能体会话触发器重新显示配置头像。
describe('MEA resource-icons: agent trigger', () => {
  it.each([
    ['Agent', false],
    ['🤖 Agent', false],
    ['Agent', true],
    ['🤖 Agent', true]
  ] as const)('保留名称 %s 并隐藏配置头像（紧凑模式：%s）', (name, iconOnly) => {
    render(
      <AgentConversationControls
        agent={{ id: 'agent-1', name, configuration: { avatar: '🤖' } } as AgentEntity}
        selectAgentLabel="Agent"
        selectModelLabel="Model"
        selectWorkspaceLabel="Workspace"
        shouldAutoSelectCreatedAgent={false}
        showModelControl={false}
        side="bottom"
        iconOnly={iconOnly}
        agentTriggerMode="edit"
        canChangeModel
        onAgentChange={vi.fn()}
        onModelSelect={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', { name })
    expect(within(trigger).getByText(name)).toBeInTheDocument()
    expect(trigger.querySelectorAll('svg.lucide-bot')).toHaveLength(iconOnly ? 1 : 0)
    expect(within(trigger).queryByText('🤖')).not.toBeInTheDocument()
  })
})
