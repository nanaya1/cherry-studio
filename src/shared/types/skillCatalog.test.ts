import { describe, expect, it } from 'vitest'

import { SkillCatalogSnapshotSchema } from './skillCatalog'

const snapshot = {
  schemaVersion: 1,
  revision: 1,
  defaultLocale: 'zh-CN',
  supportedLocales: ['zh-CN', 'en-US'],
  industries: [
    {
      code: 'aerospace',
      sortOrder: 10,
      isEnabled: true,
      translations: {
        'zh-CN': { name: '航空航天' },
        'en-US': { name: 'Aerospace' }
      }
    }
  ],
  professionalDimensions: [
    {
      code: 'research-design',
      sortOrder: 10,
      isEnabled: true,
      translations: {
        'zh-CN': { name: '研发设计' },
        'en-US': { name: 'Research and design' }
      }
    }
  ],
  skills: [
    {
      id: 'browser-use',
      industryScope: 'specific',
      industryCodes: ['aerospace'],
      professionalDimensionCodes: ['research-design'],
      logo: null,
      artifact: {
        type: 'directory',
        location: 'packages/browser-use',
        version: '1.0.0',
        sha256: `sha256:${'a'.repeat(64)}`
      },
      status: 'published',
      sortOrder: 10,
      translations: {
        'zh-CN': { name: '浏览器使用', description: '通过浏览器完成页面操作。' },
        'en-US': { name: 'Browser use', description: 'Operate pages through a browser.' }
      }
    }
  ]
}

describe('SkillCatalogSnapshotSchema', () => {
  it('accepts a bilingual catalog with valid relationships', () => {
    expect(SkillCatalogSnapshotSchema.parse(snapshot).skills).toHaveLength(1)
  })

  it('rejects relationships that reference unknown codes', () => {
    const invalid = structuredClone(snapshot)
    invalid.skills[0].industryCodes = ['unknown']

    expect(() => SkillCatalogSnapshotSchema.parse(invalid)).toThrow(/unknown industry/i)
  })

  it('requires complete default-locale translations for published entries', () => {
    const invalid = structuredClone(snapshot) as any
    delete invalid.skills[0].translations['zh-CN']

    expect(() => SkillCatalogSnapshotSchema.parse(invalid)).toThrow(/defaultLocale/i)
  })

  it('rejects universal skills with explicit industry relationships', () => {
    const invalid = structuredClone(snapshot)
    invalid.skills[0].industryScope = 'universal'

    expect(() => SkillCatalogSnapshotSchema.parse(invalid)).toThrow(/universal/i)
  })

  it('rejects paths that escape the snapshot root', () => {
    const invalid = structuredClone(snapshot)
    invalid.skills[0].artifact.location = '../browser-use'

    expect(() => SkillCatalogSnapshotSchema.parse(invalid)).toThrow()
  })
})
