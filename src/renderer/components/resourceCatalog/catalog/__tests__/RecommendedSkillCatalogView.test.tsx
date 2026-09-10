// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { toast } from '@renderer/services/toast'
import type { SkillCatalogResponse } from '@shared/data/api/schemas/skillCatalog'
import { MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
        'workspace.skill_catalog.version': '版本',
        'workspace.skill_catalog.install': `安装 ${options?.name ?? ''}`,
        'settings.skills.install': '安装',
        'settings.skills.installFailed': `${options?.name ?? ''} 安装失败`
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

  it('refreshes the catalog after a failed install so the card flips to the conflict warning', async () => {
    const user = userEvent.setup()
    const notInstalled: SkillCatalogResponse = {
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
          installState: 'not-installed',
          installedSkillId: null,
          conflictingInstalledSkillId: null
        }
      ]
    }
    const installTrigger = vi.fn().mockRejectedValue(new Error('refusing to overwrite'))
    MockUseDataApiUtils.mockMutationWithTrigger('POST', '/skill-catalog/:catalogSkillId/install', installTrigger)

    const refetch = vi.fn(async () => {
      MockUseDataApiUtils.mockQueryResult('/skill-catalog', { data: catalog })
    })
    MockUseDataApiUtils.mockQueryResult('/skill-catalog', { data: notInstalled, refetch })
    render(<RecommendedSkillCatalogView search="" onViewInstalled={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: `安装 ${notInstalled.skills[0].name}` }))

    await waitFor(() => expect(refetch).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: '名称冲突' })).toBeInTheDocument())
    expect(toast.error).toHaveBeenCalled()
  })
})
