import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readSkillFileMock } = vi.hoisted(() => ({
  readSkillFileMock: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn() }) }
}))

import { SkillFileBrowser } from '../SkillFileBrowser'

describe('SkillFileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readSkillFileMock.mockResolvedValue({
      success: true,
      data: '---\nname: review-helper\ndescription: Reviews code\n---\n\n# Review Helper\n\nUse this skill.'
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        skill: {
          readSkillFile: readSkillFileMock
        }
      }
    })
  })

  it('shows the complete skill file with simple Markdown formatting', async () => {
    render(<SkillFileBrowser skillId="skill-1" />)

    expect(await screen.findByText('name: review-helper', { exact: false, selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Review Helper' })).toBeInTheDocument()
    expect(screen.getByText('Use this skill.')).toBeInTheDocument()
    expect(readSkillFileMock).toHaveBeenCalledWith('skill-1', 'SKILL.md')
  })

  it('renders raw HTML in the skill file as inert text', async () => {
    readSkillFileMock.mockResolvedValueOnce({ success: true, data: '<img src=x onerror="alert(1)">' })

    const { container } = render(<SkillFileBrowser skillId="skill-1" />)

    expect(await screen.findByText(/alert\(1\)/)).toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('shows the localized failure state when SKILL.md cannot be read', async () => {
    readSkillFileMock.mockResolvedValueOnce({ success: false, error: 'read failed' })

    render(<SkillFileBrowser skillId="skill-1" />)

    expect(await screen.findByText('library.skill_detail.file_load_failed')).toBeInTheDocument()
  })
})
