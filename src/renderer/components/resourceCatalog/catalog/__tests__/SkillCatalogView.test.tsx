// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ipcRequest: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.ipcRequest }
}))

vi.mock('@renderer/components/resourceCatalog/dialogs/delete', () => ({
  ResourceDeleteConfirmDialog: () => null
}))

vi.mock('../ResourceCatalogDialogs', () => ({
  ResourceCatalogDialogs: () => null
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common.all': 'All',
        'settings.skills.installed': 'installed',
        'workspace.skillsConnectors.mySkills': 'My Skills',
        'workspace.skillsConnectors.sourceFilter': 'Filter skills by source',
        'workspace.skillsConnectors.sources.builtin': 'Built-in',
        'workspace.skillsConnectors.sources.custom': 'Custom (Upload)',
        'workspace.skillsConnectors.sources.marketplace': 'Marketplace (Online)'
      })[key] ?? key
  })
}))

import { getSkillInitial, getSkillSourceFilter, SkillCatalogView } from '../SkillCatalogView'

function skill(id: string, name: string, source: string, iconFileName?: string) {
  return {
    id,
    type: 'skill',
    name,
    description: `${name} description`,
    avatar: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    raw: { id, name, source, iconFileName, version: '1.0.0' }
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
    expect(within(toolbar!).getByRole('button', { name: 'library.skill_add.add' })).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Custom (Upload) 3' }))

    expect(screen.getByLabelText('Local skill')).toBeVisible()
    expect(screen.getByLabelText('ZIP skill')).toBeVisible()
    expect(screen.getByLabelText('System skill')).toBeVisible()
    expect(screen.queryByLabelText('Builtin skill')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Marketplace skill')).not.toBeInTheDocument()
  })

  it('resolves only skills carrying icon metadata', async () => {
    render(<SkillCatalogView controller={controller() as never} />)

    await waitFor(() => {
      expect(mocks.ipcRequest).toHaveBeenCalledWith('skill.icons.resolve', { skillIds: ['builtin'] })
    })
  })
})
