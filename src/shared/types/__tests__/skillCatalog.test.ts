import { describe, expect, it } from 'vitest'

import { type CatalogManifest, type SkillCatalogSnapshot, validateSkillCatalog } from '../skillCatalog'

const sha = (hex: string) => `sha256:${hex}`
const DIGEST = sha('a'.repeat(64))

const validManifest: CatalogManifest = {
  schemaVersion: 1,
  revision: 1,
  generatedAt: '2026-09-09T14:00:00Z',
  minAppVersion: '1.0.0',
  files: { 'catalog.json': sha('c'.repeat(64)) }
}

const validSnapshot: SkillCatalogSnapshot = {
  schemaVersion: 1,
  revision: 1,
  defaultLocale: 'zh-CN',
  supportedLocales: ['zh-CN', 'en-US'],
  industries: [
    {
      code: 'aerospace',
      sortOrder: 10,
      isEnabled: true,
      translations: { 'zh-CN': { name: '航空航天' }, 'en-US': { name: 'Aerospace' } }
    }
  ],
  professionalDimensions: [
    {
      code: 'research-design',
      sortOrder: 10,
      isEnabled: true,
      translations: { 'zh-CN': { name: '研发设计' }, 'en-US': { name: 'Research and design' } }
    }
  ],
  skills: [
    {
      id: 'browser-use',
      industryScope: 'universal',
      industryCodes: [],
      professionalDimensionCodes: ['research-design'],
      logo: { type: 'snapshot', location: 'logos/browser-use.png', sha256: DIGEST },
      artifact: { type: 'directory', location: 'packages/browser-use', version: '1.0.0', sha256: DIGEST },
      status: 'published',
      sortOrder: 10,
      translations: {
        'zh-CN': { name: '浏览器使用', description: '通过浏览器完成页面操作与信息获取。' },
        'en-US': { name: 'Browser use', description: 'Operate web pages and retrieve information through a browser.' }
      }
    }
  ]
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

describe('skill catalog protocol', () => {
  it('accepts a valid bundled snapshot', () => {
    const result = validateSkillCatalog(validManifest, clone(validSnapshot), { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(true)
  })

  it('rejects a snapshot with duplicate skill ids', () => {
    const s = clone(validSnapshot)
    s.skills.push(clone(s.skills[0]))
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.ok ? [] : result.errors)).toMatch(/duplicate skill id/i)
  })

  it('rejects a snapshot with duplicate industry codes', () => {
    const s = clone(validSnapshot)
    s.industries.push(clone(s.industries[0]))
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a snapshot with duplicate professional dimension codes', () => {
    const s = clone(validSnapshot)
    s.professionalDimensions.push(clone(s.professionalDimensions[0]))
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a skill referencing an unknown industry code', () => {
    const s = clone(validSnapshot)
    s.skills[0].industryScope = 'specific'
    s.skills[0].industryCodes = ['does-not-exist']
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.ok ? [] : result.errors)).toMatch(/unknown industry code/i)
  })

  it('rejects a skill referencing an unknown professional dimension code', () => {
    const s = clone(validSnapshot)
    s.skills[0].professionalDimensionCodes = ['does-not-exist']
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.ok ? [] : result.errors)).toMatch(/unknown professional dimension code/i)
  })

  it('rejects a universal skill that carries industry codes', () => {
    const s = clone(validSnapshot)
    s.skills[0].industryCodes = ['aerospace']
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a specific skill with no industry codes', () => {
    const s = clone(validSnapshot)
    s.skills[0].industryScope = 'specific'
    s.skills[0].industryCodes = []
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects an absolute artifact location', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact.location = '/etc/passwd'
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a path-traversal artifact location', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact.location = 'packages/../escape'
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a file: URL artifact location', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact.location = 'file:///packages/x'
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects an illegal sha256', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact.sha256 = 'not-a-hash'
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects an empty artifact version', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact.version = ''
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest whose revision disagrees with the catalog', () => {
    const m = clone(validManifest)
    m.revision = 2
    const result = validateSkillCatalog(m, clone(validSnapshot), { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.ok ? [] : result.errors)).toMatch(/revision/i)
  })

  it('rejects a manifest whose schemaVersion disagrees with the catalog', () => {
    const m = clone(validManifest)
    m.schemaVersion = 2
    const result = validateSkillCatalog(m, clone(validSnapshot), { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.ok ? [] : result.errors)).toMatch(/schemaVersion/i)
  })

  it('rejects a client older than minAppVersion', () => {
    const result = validateSkillCatalog(validManifest, clone(validSnapshot), { currentAppVersion: '0.9.0' })
    expect(result.ok).toBe(false)
  })

  it('skips version compatibility when no current version is supplied', () => {
    const result = validateSkillCatalog(validManifest, clone(validSnapshot))
    expect(result.ok).toBe(true)
  })

  it('requires a published skill to have a defaultLocale translation', () => {
    const s = clone(validSnapshot)
    delete s.skills[0].translations[s.defaultLocale]
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('requires an enabled industry to have a defaultLocale translation', () => {
    const s = clone(validSnapshot)
    delete s.industries[0].translations[s.defaultLocale]
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(false)
  })

  it('allows a draft skill without any translation', () => {
    // Contract: only published/enabled rows must carry the defaultLocale text;
    // draft and disabled rows are not shown and need not be translated yet.
    const s = clone(validSnapshot)
    s.skills[0].status = 'draft'
    s.skills[0].translations = {}
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(true)
  })

  it('allows a disabled skill without any translation', () => {
    const s = clone(validSnapshot)
    s.skills[0].status = 'disabled'
    s.skills[0].translations = {}
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(true)
  })

  it('accepts a skill with a null logo', () => {
    const s = clone(validSnapshot)
    s.skills[0].logo = null
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(true)
  })

  it('accepts an archive artifact so the protocol stays forward-compatible', () => {
    const s = clone(validSnapshot)
    s.skills[0].artifact = { type: 'archive', location: 'packages/browser-use.zip', version: '1.0.0', sha256: DIGEST }
    const result = validateSkillCatalog(validManifest, s, { currentAppVersion: '1.2.0' })
    expect(result.ok).toBe(true)
  })
})
