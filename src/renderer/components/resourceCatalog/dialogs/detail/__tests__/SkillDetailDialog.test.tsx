import { DIALOG_UNMOUNT_DELAY_MS } from '@cherrystudio/ui/utils'
import type { InstalledSkill } from '@shared/types/skill'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SkillDetailDialog from '../SkillDetailDialog'

const { openRouteMock, uiLanguage } = vi.hoisted(() => ({
  openRouteMock: vi.fn(),
  uiLanguage: { current: 'en-US', resolved: undefined as string | undefined }
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openRoute: openRouteMock
}))

vi.mock('@renderer/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn() }) }
}))

vi.mock('../SkillFileBrowser', () => ({
  SkillFileBrowser: ({ skillId }: { skillId: string }) => <section>skill browser: {skillId}</section>
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: uiLanguage.current, resolvedLanguage: uiLanguage.resolved }
  })
}))

vi.mock('@cherrystudio/ui', () => {
  let onDialogOpenChange: ((open: boolean) => void) | undefined

  return {
    Avatar: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
    AvatarFallback: ({ children, ...props }: ComponentProps<'span'>) => <span {...props}>{children}</span>,
    AvatarImage: (props: ComponentProps<'img'>) => <img {...props} />,
    Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Button: ({ children, size, variant, ...props }: ComponentProps<'button'> & { size?: string; variant?: string }) => {
      void size
      void variant
      return (
        <button type="button" {...props}>
          {children}
        </button>
      )
    },
    Dialog: ({
      children,
      open,
      onOpenChange
    }: {
      children: ReactNode
      open: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      onDialogOpenChange = onOpenChange
      return open ? <>{children}</> : null
    },
    DialogContent: ({ children, className, size }: { children: ReactNode; className?: string; size?: string }) => (
      <div role="dialog" className={className} data-size={size}>
        {children}
        <button type="button" onClick={() => onDialogOpenChange?.(false)}>
          common.close
        </button>
      </div>
    ),
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Separator: () => <hr />
  }
})

function createSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    id: 'skill-1',
    name: 'Review Helper',
    displayName: null,
    displayNameEn: null,
    description: 'Review pull requests',
    descriptionEn: null,
    folderName: 'review-helper',
    source: 'local',
    sourceUrl: null,
    namespace: null,
    author: null,
    version: null,
    sourceTags: ['review'],
    contentHash: 'hash',
    isGlobalEnabled: true,
    isEnabled: true,
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
    ...overrides
  }
}

describe('SkillDetailDialog', () => {
  beforeEach(() => {
    openRouteMock.mockReset()
    uiLanguage.current = 'en-US'
    uiLanguage.resolved = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The system locale and the app language differ often enough that one machine's default hides the
  // bug; asserting both orders means whichever locale the runner has, one case still catches it.
  it.each([
    ['zh-CN', /^2026\/\d{2}\/\d{2}$/],
    ['en-US', /^\d{2}\/\d{2}\/2026$/]
  ])('formats dates for the selected app language (%s), not the system locale', (language, expected) => {
    uiLanguage.current = language
    render(<SkillDetailDialog skill={createSkill()} open onOpenChange={vi.fn()} />)

    expect(screen.getAllByText(expected)).toHaveLength(2)
  })

  it('follows the locale that supplied the copy when the requested one has no bundle', () => {
    // `en-GB` has no locale pack, so i18next renders `en-US` strings; formatting the date as `en-GB`
    // would put UK-ordered dates next to US English text.
    uiLanguage.current = 'en-GB'
    uiLanguage.resolved = 'en-US'
    render(<SkillDetailDialog skill={createSkill()} open onOpenChange={vi.fn()} />)

    expect(screen.getAllByText(/^\d{2}\/\d{2}\/2026$/)).toHaveLength(2)
  })

  it('shows skill metadata and the restored file browser without delete entry points', () => {
    render(<SkillDetailDialog skill={createSkill()} open onOpenChange={vi.fn()} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-size', 'xl')
    expect(dialog).toHaveClass('max-h-[min(720px,calc(100vh-2rem))]')
    expect(screen.getByRole('heading', { name: 'Review Helper' })).toBeInTheDocument()
    expect(screen.getByText('Review pull requests')).toBeInTheDocument()
    expect(screen.getByText('library.skill_detail.created_at')).toBeInTheDocument()
    expect(screen.getByText('library.skill_detail.updated_at')).toBeInTheDocument()
    expect(screen.getByText('skill browser: skill-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'library.action.uninstall' })).not.toBeInTheDocument()
  })

  it('opens a new Agent task with the selected skill', async () => {
    const user = userEvent.setup()
    render(<SkillDetailDialog skill={createSkill()} open onOpenChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'library.skill_detail.try' }))

    expect(openRouteMock).toHaveBeenCalledWith('/app/new-task', { mode: 'agent', skillId: 'skill-1' })
  })

  it('keeps the selected skill mounted until the close animation finishes', async () => {
    vi.useFakeTimers()
    const onOpenChange = vi.fn()

    render(<SkillDetailDialog skill={createSkill()} open onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))

    expect(onOpenChange).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTime(DIALOG_UNMOUNT_DELAY_MS - 1))
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTime(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not render without a selected skill', () => {
    render(<SkillDetailDialog skill={null} open onOpenChange={vi.fn()} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
