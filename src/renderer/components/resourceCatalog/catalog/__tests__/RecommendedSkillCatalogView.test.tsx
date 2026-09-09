// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SkillCatalogResponse } from '@shared/data/api/schemas/skillCatalog'
import { MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { name?: string }) =>
      ({
        'workspace.skill_catalog.all': '全部',
        'workspace.skill_catalog.universal': '全行业',
        'workspace.skill_catalog.name_conflict': '名称冲突',
        'workspace.skill_catalog.name_conflict_title': '无法安装推荐技能',
        'workspace.skill_catalog.name_conflict_description': `${options?.name ?? ''} 与已安装技能使用了相同的文件夹名称。`,
        'workspace.skill_catalog.name_conflict_action': '查看已安装技能',
        'workspace.skill_catalog.name_conflict_cancel': '稍后处理',
        'workspace.skill_catalog.basic_info': '基本信息',
        'workspace.skill_catalog.version': '版本'
      })[key] ?? key
  })
}))

import { RecommendedSkillCatalogView } from '../RecommendedSkillCatalogView'

const catalog: SkillCatalogResponse = {
  industries: [],
  professionalDimensions: [],
  skills: [
    {
      id: 'browser-use',
      name: '浏览器使用',
      description: '浏览器自动化技能',
      version: '1.0.0',
      industryScope: 'universal',
      industries: [],
      professionalDimensions: [],
      logoUrl: null,
      installState: 'name-conflict',
      installedSkillId: null,
      conflictingInstalledSkillId: 'installed-skill'
    }
  ]
}

describe('RecommendedSkillCatalogView', () => {
  beforeEach(() => {
    MockUseDataApiUtils.resetMocks()
    MockUseDataApiUtils.mockQueryData('/skill-catalog', catalog)
  })

  afterEach(cleanup)

  it('explains a folder-name conflict without attempting installation and links to installed skills', async () => {
    const user = userEvent.setup()
    const installTrigger = vi.fn()
    const onViewInstalled = vi.fn()
    MockUseDataApiUtils.mockMutationWithTrigger('POST', '/skill-catalog/:catalogSkillId/install', installTrigger)
    render(<RecommendedSkillCatalogView search="" onViewInstalled={onViewInstalled} />)

    await user.click(screen.getByRole('button', { name: '名称冲突' }))

    expect(screen.getByRole('dialog')).toHaveTextContent('无法安装推荐技能')
    expect(screen.getByRole('dialog')).toHaveTextContent('浏览器使用 与已安装技能使用了相同的文件夹名称。')
    expect(installTrigger).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '查看已安装技能' }))
    expect(onViewInstalled).toHaveBeenCalledOnce()
  })
})
