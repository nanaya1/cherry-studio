import { render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import IndustrialVideoAgentComposerSlot from './IndustrialVideoAgentComposerSlot'

const state = vi.hoisted(() => ({
  record: null as { state: string; unknownSubmissions: unknown[] } | null,
  job: null as { status: string } | null,
  error: '',
  refresh: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./useIndustrialVideoProduction', () => ({ useIndustrialVideoProduction: () => state }))
vi.mock('../agents/AgentComposerSlot', () => ({
  default: ({ sendDisabled }: { sendDisabled: boolean }) => (
    <button type="button" disabled={sendDisabled}>
      send
    </button>
  )
}))

describe('industrial video server execution guard', () => {
  it('blocks server generation and unknown outcomes even when Agent is idle, allowing review only', async () => {
    const props = { sessionId: 'video-1', isStreaming: false, sendDisabled: false } as ComponentProps<
      typeof IndustrialVideoAgentComposerSlot
    >
    state.record = { state: 'generating', unknownSubmissions: [] }
    const { rerender } = render(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.record = { state: 'storyboard_submitted', unknownSubmissions: [] }
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
    state.job = { status: 'running' }
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.job = null
    state.record.unknownSubmissions = [{}]
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.record.unknownSubmissions = []
    state.error = 'offline'
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
  })
})
