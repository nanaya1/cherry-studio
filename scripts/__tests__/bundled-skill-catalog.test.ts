import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateSkillCatalog } from '../../src/shared/types/skillCatalog'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const snapshotRoot = path.join(projectRoot, 'resources/skill-catalog/v1')

describe('随包技能目录兼容性', () => {
  it('当前应用版本可加载完整且非空的推荐技能目录', () => {
    const { version } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(snapshotRoot, 'manifest.json'), 'utf8'))
    const catalogBuffer = readFileSync(path.join(snapshotRoot, 'catalog.json'))
    const result = validateSkillCatalog(manifest, JSON.parse(catalogBuffer.toString('utf8')), {
      currentAppVersion: version
    })

    expect(result.ok, result.ok ? undefined : result.errors.join('; ')).toBe(true)
    if (!result.ok) throw new Error(result.errors.join('; '))

    expect(result.manifest.files['catalog.json']).toBe(
      `sha256:${createHash('sha256').update(catalogBuffer).digest('hex')}`
    )
    expect(result.snapshot.skills.length).toBeGreaterThan(0)
    expect(result.snapshot.skills.every((skill) => skill.status === 'published')).toBe(true)
  })
})
