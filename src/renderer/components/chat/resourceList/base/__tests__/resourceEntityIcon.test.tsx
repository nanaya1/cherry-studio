import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderAgentEntityIcon, renderAssistantEntityIcon } from '../resourceEntityIcon'

describe('resource entity icons', () => {
  it('uses the resource-center assistant icon when the icon type is none', () => {
    const { container } = render(renderAssistantEntityIcon('none', { emoji: '🍒' }))

    expect(container.querySelector('svg.lucide-message-circle')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('🍒')
  })

  it('uses the resource-center agent icon when the icon type is none', () => {
    const { container } = render(renderAgentEntityIcon('none', { configuration: { avatar: '🤖' } }))

    expect(container.querySelector('svg.lucide-bot')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('🤖')
  })
})
