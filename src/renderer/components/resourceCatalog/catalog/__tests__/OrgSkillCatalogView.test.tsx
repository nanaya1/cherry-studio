/**
 * [enterprise] OrgSkillCatalogView 单元测试
 * 组织技能卡片视图：网格卡片渲染、安装按钮、已装状态、搜索过滤、未登录提示。
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useOrgSkills: vi.fn(),
  useOrgAccountSession: vi.fn(() => ({ status: { phase: 'signed-in' } }))
}))

vi.mock('@renderer/hooks/useOrgSkills', () => ({
  useOrgSkills: mocks.useOrgSkills
}))
vi.mock('@renderer/hooks/useOrgAccountSession', () => ({
  useOrgAccountSession: mocks.useOrgAccountSession
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { OrgSkillCatalogView } from '../OrgSkillCatalogView'

function orgSkill(slug: string, name: string) {
  return {
    slug,
    name,
    description: `${name} description`,
    version: '1.0.0',
    contentHash: `hash-${slug}`,
    downloadUrl: `/api/skills/${slug}/download`
  }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useOrgAccountSession.mockReturnValue({ status: { phase: 'signed-in' } })
})

describe('OrgSkillCatalogView', () => {
  it('only enables org skill requests while signed in', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [],
      loading: false,
      error: null,
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set<string>(),
      remove: vi.fn()
    })
    mocks.useOrgAccountSession.mockReturnValue({ status: { phase: 'signed-out' } })

    const { rerender } = render(<OrgSkillCatalogView />)
    expect(mocks.useOrgSkills).toHaveBeenLastCalledWith(false)

    mocks.useOrgAccountSession.mockReturnValue({ status: { phase: 'signed-in' } })
    rerender(<OrgSkillCatalogView />)
    expect(mocks.useOrgSkills).toHaveBeenLastCalledWith(true)
  })

  it('renders org skills as cards with install buttons', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A'), orgSkill('b', '技能B')],
      loading: false,
      error: null,
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set<string>(),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    expect(screen.getByRole('heading', { name: '技能A' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '技能B' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'library.org_skill.install' }).length).toBe(2)
  })

  it('marks installed skills with a disabled installed button', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A')],
      loading: false,
      error: null,
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set(['a']),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    const button = screen.getByRole('button', { name: 'library.org_skill.installed' })
    expect(button).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'library.org_skill.install' })).not.toBeInTheDocument()
  })

  it('calls install with the slug when the install button is clicked', async () => {
    const user = userEvent.setup()
    const install = vi.fn().mockResolvedValue(true)
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A')],
      loading: false,
      error: null,
      install,
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set<string>(),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    await user.click(screen.getByRole('button', { name: 'library.org_skill.install' }))
    expect(install).toHaveBeenCalledWith('a')
  })

  it('shows the disabled-notice state with remove action for org-disabled skills', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A')],
      loading: false,
      error: null,
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: ['a'],
      installedSlugs: new Set(['a']),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    expect(screen.getAllByText('library.org_skill.disabled_badge').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'library.org_skill.remove' })).toBeVisible()
  })

  it('shows the error state and keeps retry available', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [],
      loading: false,
      error: '企业服务请求失败 (401)',
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set<string>(),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    expect(screen.getByText('企业服务请求失败 (401)')).toBeVisible()
    expect(screen.getByRole('button', { name: 'common.refresh' })).toBeVisible()
  })

  it('filters cards by the search query', async () => {
    const user = userEvent.setup()
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '周报'), orgSkill('b', '代码评审')],
      loading: false,
      error: null,
      install: vi.fn(),
      installing: new Set(),
      refetch: vi.fn(),
      disabledSlugs: [],
      installedSlugs: new Set<string>(),
      remove: vi.fn()
    })
    render(<OrgSkillCatalogView />)

    await user.type(screen.getByPlaceholderText('library.org_skill.search_placeholder'), '周报')

    expect(screen.getByRole('heading', { name: '周报' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '代码评审' })).not.toBeInTheDocument()
  })
})
