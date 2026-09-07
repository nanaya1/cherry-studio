import { describe, expect, it } from 'vitest'

import { getSkillDisplayName, InstalledSkillSchema, ListSkillsQuerySchema } from '../skills'

describe('Skill schemas', () => {
  it('keeps skill sourceTags but removes outer user tags and tag filters', () => {
    const skill = {
      id: 'skill-1',
      name: 'Skill',
      displayName: null,
      displayNameEn: null,
      description: null,
      folderName: 'skill',
      source: 'builtin',
      sourceUrl: null,
      namespace: null,
      author: null,
      version: '1.2.3',
      sourceTags: ['metadata'],
      contentHash: 'hash',
      isEnabled: false,
      isGlobalEnabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }

    expect(InstalledSkillSchema.parse(skill)).toMatchObject({ sourceTags: ['metadata'], version: '1.2.3' })
    expect(InstalledSkillSchema.safeParse({ ...skill, tags: [] }).success).toBe(false)
    expect(ListSkillsQuerySchema.safeParse({ tagIds: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(false)
  })

  it('falls back from displayName to name for display', () => {
    expect(
      getSkillDisplayName({ displayName: '小樱的工作准则', displayNameEn: null, name: 'xiao-ying-work-rules' })
    ).toBe('小樱的工作准则')
    expect(getSkillDisplayName({ displayName: null, displayNameEn: null, name: 'xiao-ying-work-rules' })).toBe(
      'xiao-ying-work-rules'
    )
  })

  it('prefers displayNameEn only for English locales', () => {
    const skill = { displayName: '小樱的工作准则', displayNameEn: 'Sakura Work Rules', name: 'xiao-ying-work-rules' }

    expect(getSkillDisplayName(skill, 'en-US')).toBe('Sakura Work Rules')
    expect(getSkillDisplayName(skill, 'en')).toBe('Sakura Work Rules')
    expect(getSkillDisplayName(skill, 'zh-CN')).toBe('小樱的工作准则')
    expect(getSkillDisplayName(skill, 'ja-JP')).toBe('小樱的工作准则')
    expect(getSkillDisplayName(skill, null)).toBe('小樱的工作准则')
  })

  it('falls back to displayName when displayNameEn is absent even in English locales', () => {
    const skill = { displayName: '小樱的工作准则', displayNameEn: null, name: 'xiao-ying-work-rules' }

    expect(getSkillDisplayName(skill, 'en-US')).toBe('小樱的工作准则')
  })
})
