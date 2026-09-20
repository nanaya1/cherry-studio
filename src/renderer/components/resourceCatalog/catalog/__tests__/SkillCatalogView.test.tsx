// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as ReactModule from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryUiModule from '@cherrystudio/ui'

const mocks = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
  updateGlobalEnabled: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.ipcRequest }
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useSkillMutationsById: () => ({
    updateGlobalEnabled: mocks.updateGlobalEnabled,
    isUpdating: false
  })
}))

vi.mock('@renderer/components/resourceCatalog/dialogs/delete', () => ({
  ResourceDeleteConfirmDialog: () => null
}))

// [enterprise] 覆写 DropdownMenu 家族为可交互 fake（真实 Radix 内容仅在 open 时渲染，jsdom 点击不可靠）。
// 其余组件保留真实实现，避免影响既有断言。
vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof CherryUiModule>()
  const React = await vi.importActual<typeof ReactModule>('react')
  const DropdownMenuContext = React.createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })

  return {
    ...actual,
    DropdownMenu: ({
      children,
      open,
      onOpenChange
    }: {
      children?: ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      const [internalOpen, setInternalOpen] = React.useState(open ?? false)
      const actualOpen = open ?? internalOpen
      const setOpen = (nextOpen: boolean) => {
        if (open === undefined) setInternalOpen(nextOpen)
        onOpenChange?.(nextOpen)
      }
      return <DropdownMenuContext value={{ open: actualOpen, setOpen }}>{children}</DropdownMenuContext>
    },
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => {
      const { open } = React.use(DropdownMenuContext)
      return open ? <div role="menu">{children}</div> : null
    },
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
      ...props
    }: ComponentProps<'button'> & {
      disabled?: boolean
      onSelect?: (event: React.MouseEvent<HTMLButtonElement>) => void
    }) => (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onClick={(event) => onSelect?.(event)}
        {...props}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({ asChild, children }: { asChild?: boolean; children?: ReactNode }) => {
      const { open, setOpen } = React.use(DropdownMenuContext)
      if (asChild) return <span onClickCapture={() => setOpen(!open)}>{children}</span>
      return (
        <button type="button" onClick={() => setOpen(!open)}>
          {children}
        </button>
      )
    }
  }
})

vi.mock('../ResourceCatalogDialogs', () => ({
  ResourceCatalogDialogs: () => null
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common.all': 'All',
        'settings.skills.globalToggle': 'Enable skill globally',
        'settings.skills.installed': 'installed',
        'workspace.skillsConnectors.mySkills': 'My Skills',
        'workspace.skillsConnectors.sourceFilter': 'Filter skills by source',
        'workspace.skillsConnectors.sources.builtin': 'Built-in',
        'workspace.skillsConnectors.sources.custom': 'Custom (Upload)',
        'workspace.skillsConnectors.sources.marketplace': 'Marketplace (Online)',
        'workspace.skillsConnectors.sources.org': 'Organization',
        'library.skill_add.add': 'Add skill',
        'library.skill_add.org_skills': 'Organization skills'
      })[key] ?? key
  })
}))

import { getSkillInitial, getSkillSourceFilter, SkillCatalogView } from '../SkillCatalogView'

function skill(id: string, name: string, source: string, iconFileName?: string, sourceUrl?: string) {
  return {
    id,
    type: 'skill',
    name,
    description: `${name} description`,
    avatar: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    raw: { id, name, source, sourceUrl, iconFileName, version: '1.0.0', isGlobalEnabled: true }
  }
}

function controller() {
  const resources = [
    skill('builtin', 'Builtin skill', 'builtin', 'icon.png'),
    skill('marketplace', 'Marketplace skill', 'marketplace'),
    skill('local', 'Local skill', 'local'),
    skill('zip', 'ZIP skill', 'zip'),
    skill('system', 'System skill', 'system')
  ]

  return {
    resourceError: undefined,
    refetch: vi.fn(),
    gridProps: {
      resources,
      allResources: resources,
      search: '',
      isLoading: false,
      onSearchChange: vi.fn(),
      onOpenSkillMarketplace: vi.fn(),
      onOpenSystemSkills: vi.fn(),
      onCreate: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn()
    },
    dialogs: {
      deleteConfirm: null,
      setDeleteConfirm: vi.fn()
    }
  }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ipcRequest.mockResolvedValue({ builtin: 'file:///managed/icon.png' })
})

describe('SkillCatalogView helpers', () => {
  it.each([
    ['builtin', 'builtin'],
    ['marketplace', 'marketplace'],
    ['local', 'custom'],
    ['zip', 'custom'],
    ['system', 'custom'],
    ['unknown', null]
  ])('maps source %s to %s', (source, expected) => {
    expect(getSkillSourceFilter(source)).toBe(expected)
  })

  it('[enterprise] maps a copied organization skill to the organization source', () => {
    expect(getSkillSourceFilter('local', 'org-skill:review')).toBe('org')
  })

  it('uses the first visible uppercased character as the image fallback', () => {
    expect(getSkillInitial('  frontend-design')).toBe('F')
    expect(getSkillInitial('  中文技能')).toBe('中')
    expect(getSkillInitial('   ')).toBe('?')
  })
})

describe('SkillCatalogView', () => {
  it('shows source counts and filters local, ZIP, and system skills as custom uploads', async () => {
    const user = userEvent.setup()
    render(<SkillCatalogView controller={controller() as never} />)

    expect(screen.getByRole('tab', { name: 'All 5' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Built-in 1' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Marketplace (Online) 1' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Custom (Upload) 3' })).toBeVisible()

    const sourceTabs = screen.getByRole('tablist', { name: 'Filter skills by source' })
    const toolbar = sourceTabs.parentElement
    expect(toolbar).not.toBeNull()
    expect(within(toolbar!).getByPlaceholderText('library.toolbar.search_placeholder')).toBeVisible()
    expect(within(toolbar!).getByRole('button', { name: 'Add skill' })).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Custom (Upload) 3' }))

    expect(screen.getByLabelText('Local skill')).toBeVisible()
    expect(screen.getByLabelText('ZIP skill')).toBeVisible()
    expect(screen.getByLabelText('System skill')).toBeVisible()
    expect(screen.queryByLabelText('Builtin skill')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Marketplace skill')).not.toBeInTheDocument()
  })

  it('[enterprise] shows an organization tag for a copied organization skill', () => {
    const testController = controller()
    const orgSkill = skill('org-copy', 'Organization skill', 'local', undefined, 'org-skill:review')
    testController.gridProps.resources = [orgSkill]
    testController.gridProps.allResources = [orgSkill]

    render(<SkillCatalogView controller={testController as never} />)

    expect(within(screen.getByLabelText('Organization skill')).getByText('Organization')).toBeVisible()
  })

  it('toggles a skill globally without opening its details', async () => {
    const user = userEvent.setup()
    const testController = controller()
    mocks.updateGlobalEnabled.mockResolvedValueOnce({})
    render(<SkillCatalogView controller={testController as never} />)

    await waitFor(() => expect(mocks.ipcRequest).toHaveBeenCalled())
    const toggles = screen.getAllByRole('switch', { name: 'Enable skill globally' })
    await user.click(toggles[0])

    expect(mocks.updateGlobalEnabled).toHaveBeenCalledWith(false)
    expect(testController.gridProps.onEdit).not.toHaveBeenCalled()
  })

  it('resolves only skills carrying icon metadata', async () => {
    render(<SkillCatalogView controller={controller() as never} />)

    await waitFor(() => {
      expect(mocks.ipcRequest).toHaveBeenCalledWith('skill.icons.resolve', { skillIds: ['builtin'] })
    })
  })

  it('[enterprise] shows the org skills entry as a top-level button when the handler exists', async () => {
    const user = userEvent.setup()
    const testController = controller()
    const onOpenOrgSkills = vi.fn()
    ;(testController.gridProps as Record<string, unknown>).onOpenOrgSkills = onOpenOrgSkills
    render(<SkillCatalogView controller={testController as never} />)

    const orgButton = screen.getByRole('button', { name: 'Organization skills' })
    await user.click(orgButton)
    expect(onOpenOrgSkills).toHaveBeenCalledTimes(1)
  })

  it('[enterprise] keeps the org item out of the add dropdown when the handler exists', async () => {
    const user = userEvent.setup()
    const testController = controller()
    ;(testController.gridProps as Record<string, unknown>).onOpenOrgSkills = vi.fn()
    render(<SkillCatalogView controller={testController as never} />)

    await user.click(screen.getByRole('button', { name: 'Add skill' }))

    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.some((item) => /Organization skills/.test(item.textContent ?? ''))).toBe(false)
    expect(within(menu).getByRole('menuitem', { name: 'library.skill_add.online_search' })).toBeVisible()
  })

  it('[enterprise] hides the org skills button when no handler is available', () => {
    render(<SkillCatalogView controller={controller() as never} />)

    expect(screen.queryByRole('button', { name: 'Organization skills' })).not.toBeInTheDocument()
  })
})
