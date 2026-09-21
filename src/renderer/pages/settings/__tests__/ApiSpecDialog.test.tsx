import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

// Render a marker instead of the real markdown pipeline (streamdown/shiki stack).
vi.mock('@renderer/components/markdown', () => ({
  StaticMarkdown: ({ children }: { children: string }) => <div data-testid="spec-markdown">{children}</div>
}))

import specMarkdown from '../RemoteKnowledgeSettings/api-spec.md?raw'
import { ApiSpecDialog, ViewApiSpecButton } from '../RemoteKnowledgeSettings/ApiSpecDialog'

describe('ApiSpecDialog', () => {
  it('renders the packaged API spec markdown when opened', () => {
    render(<ApiSpecDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByText('settings.remoteKnowledge.apiSpec.title')).toBeInTheDocument()
    const markdown = screen.getByTestId('spec-markdown')
    expect(markdown).toHaveTextContent('GET /v1/health')
    expect(markdown).toHaveTextContent('/v1/knowledge/search')
    expect(markdown).toHaveTextContent('/v1/knowledge/read')
  })

  it('renders nothing while closed', () => {
    render(<ApiSpecDialog open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('spec-markdown')).not.toBeInTheDocument()
  })
})

describe('ViewApiSpecButton', () => {
  it('fires onClick with the localized label', async () => {
    const onClick = vi.fn()
    render(<ViewApiSpecButton onClick={onClick} />)

    await userEvent.click(screen.getByRole('button', { name: 'settings.remoteKnowledge.apiSpec.viewDocs' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

// Keep the ?raw import contract honest: the packaged doc must be the real spec, not an empty file.
describe('packaged api-spec.md', () => {
  it('is the remote knowledge API spec document', () => {
    expect(specMarkdown).toContain('## 1. 概述')
    expect(specMarkdown).toContain('GET /v1/knowledge/bases')
    expect(specMarkdown).toContain('Bearer')
    expect(specMarkdown.length).toBeGreaterThan(5000)
  })
})
