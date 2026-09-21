/**
 * [enterprise] OrgSkillCatalogView 单元测试
 * 组织技能卡片视图：网格卡片渲染、安装按钮、已装状态、搜索过滤。
 * [enterprise] 公共目录改造：目录不再依赖登录态，始终启用请求（enabled=true）。
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useOrgSkills: vi.fn()
}))

vi.mock('@renderer/hooks/useOrgSkills', () => ({
  useOrgSkills: mocks.useOrgSkills
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { OrgSkillCatalogView } from '../OrgSkillCatalogView'

function orgSkill(
  slug: string,
  name: string,
  facets: { categories?: Array<{ code: string; name: string }>; tags?: Array<{ code: string; name: string }> } = {}
) {
  return {
    slug,
    name,
    description: `${name} description`,
    version: '1.0.0',
    contentHash: `hash-${slug}`,
    downloadUrl: `/api/skills/${slug}/download`,
    ...facets
  }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OrgSkillCatalogView', () => {
  // [enterprise] 公共目录：目录请求不随登录态关闭（未登录也可浏览/安装公共资源）
  it('always enables org skill requests regardless of session', () => {
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

    render(<OrgSkillCatalogView />)
    expect(mocks.useOrgSkills).toHaveBeenCalledWith(true)
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

  it('filters cards with the page-level search and does not render a local search input', () => {
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
    render(<OrgSkillCatalogView search="周报" />)

    expect(screen.queryByPlaceholderText('library.org_skill.search_placeholder')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '周报' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '代码评审' })).not.toBeInTheDocument()
  })

  // [enterprise] 分类筛选：全部/待分类固定，其余 tab 来自技能分类并集（按 code 去重）
  it('collects category tabs from the union of skill categories, deduplicated by code', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [
        orgSkill('a', '技能A', { categories: [{ code: 'c1', name: '通用行业' }] }),
        orgSkill('b', '技能B', {
          categories: [
            { code: 'c2', name: '航天航空' },
            { code: 'c1', name: '通用行业' }
          ]
        }),
        orgSkill('c', '技能C')
      ],
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

    expect(screen.getByRole('button', { name: 'workspace.skill_catalog.all' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'workspace.skill_catalog.uncategorized' })).toBeVisible()
    expect(screen.getByRole('button', { name: '通用行业' })).toBeVisible()
    expect(screen.getByRole('button', { name: '航天航空' })).toBeVisible()
    // 去重：'通用行业' 只出现一次
    expect(screen.getAllByRole('button', { name: '通用行业' }).length).toBe(1)
  })

  it('filters skills by the selected category tab', async () => {
    const user = userEvent.setup()
    mocks.useOrgSkills.mockReturnValue({
      skills: [
        orgSkill('a', '技能A', { categories: [{ code: 'c1', name: '通用行业' }] }),
        orgSkill('b', '技能B', { categories: [{ code: 'c2', name: '航天航空' }] }),
        orgSkill('c', '技能C')
      ],
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

    await user.click(screen.getByRole('button', { name: '通用行业' }))
    expect(screen.getByRole('heading', { name: '技能A' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '技能B' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '技能C' })).not.toBeInTheDocument()
  })

  it('filters uncategorized skills via the uncategorized tab', async () => {
    const user = userEvent.setup()
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A', { categories: [{ code: 'c1', name: '通用行业' }] }), orgSkill('c', '技能C')],
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

    await user.click(screen.getByRole('button', { name: 'workspace.skill_catalog.uncategorized' }))
    expect(screen.getByRole('heading', { name: '技能C' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '技能A' })).not.toBeInTheDocument()
  })

  // [enterprise] 标签行：只显示 tags；categories 仅用于筛选 tab，不上卡片（对齐推荐视图分工）
  it('renders skill tags as card tags but keeps categories off the card', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [
        orgSkill('a', '技能A', {
          categories: [{ code: 'c1', name: '通用行业' }],
          tags: [{ code: 't1', name: '规范' }]
        })
      ],
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

    // 标签组件含隐藏测量行（aria-hidden），同一文本出现两次，取可见的那份
    expect(screen.getAllByText('规范').length).toBeGreaterThan(0)
    // 分类「通用行业」只出现在筛选 tab 按钮，不作为卡片标签渲染
    expect(screen.getAllByRole('button', { name: '通用行业' }).length).toBe(1)
  })

  it('shows the version when a skill has no tags (even with categories)', () => {
    mocks.useOrgSkills.mockReturnValue({
      skills: [orgSkill('a', '技能A', { categories: [{ code: 'c1', name: '通用行业' }] })],
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

    expect(screen.getByText('v1.0.0')).toBeVisible()
  })
})
