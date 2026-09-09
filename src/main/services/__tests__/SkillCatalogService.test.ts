import { agentGlobalSkillTable } from '@data/db/schemas/agentGlobalSkill'
import { skillCatalogTable, skillCatalogTranslationTable } from '@data/db/schemas/skillCatalog'
import { SkillCatalogService } from '@main/services/SkillCatalogService'
import { setupTestDatabase } from '@test-helpers/db'
import { beforeEach, describe, expect, it } from 'vitest'

const DIGEST = `sha256:${'a'.repeat(64)}`

describe('SkillCatalogService.list', () => {
  const dbh = setupTestDatabase()
  let service: SkillCatalogService

  beforeEach(() => {
    service = new SkillCatalogService()
    dbh.db
      .insert(skillCatalogTable)
      .values({
        id: 'browser-use',
        industryScope: 'universal',
        logo: null,
        artifact: {
          type: 'directory',
          location: 'packages/browser-use',
          version: '1.0.0',
          sha256: DIGEST
        },
        status: 'published',
        sortOrder: 10,
        snapshotSource: 'bundled',
        catalogRevision: 1
      })
      .run()
    dbh.db
      .insert(skillCatalogTranslationTable)
      .values({ skillId: 'browser-use', locale: 'zh-CN', name: '浏览器使用', description: '浏览器自动化技能' })
      .run()
  })

  const installSkill = (over: Partial<typeof agentGlobalSkillTable.$inferInsert> = {}) => {
    dbh.db
      .insert(agentGlobalSkillTable)
      .values({
        id: 'installed-skill',
        name: 'Browser Use',
        folderName: 'browser-use',
        source: 'local',
        contentHash: 'sha256:local',
        ...over
      })
      .run()
  }

  it('reports a local skill occupying the catalog folder name as a name conflict', () => {
    installSkill()

    expect(service.list('zh-CN').skills[0]).toMatchObject({
      id: 'browser-use',
      installState: 'name-conflict',
      installedSkillId: null,
      conflictingInstalledSkillId: 'installed-skill'
    })
  })

  it('matches folder name conflicts case-insensitively', () => {
    installSkill({ folderName: 'Browser-Use' })

    expect(service.list('zh-CN').skills[0]).toMatchObject({
      installState: 'name-conflict',
      conflictingInstalledSkillId: 'installed-skill'
    })
  })

  it('keeps the catalog installation state when the same catalog skill is installed', () => {
    installSkill({ source: 'catalog', catalogSkillId: 'browser-use', catalogVersion: '1.0.0' })

    expect(service.list('zh-CN').skills[0]).toMatchObject({
      installState: 'installed',
      installedSkillId: 'installed-skill',
      conflictingInstalledSkillId: null
    })
  })

  it('does not report unrelated installed folder names as conflicts', () => {
    installSkill({ folderName: 'another-skill' })

    expect(service.list('zh-CN').skills[0]).toMatchObject({
      installState: 'not-installed',
      installedSkillId: null,
      conflictingInstalledSkillId: null
    })
  })
})
