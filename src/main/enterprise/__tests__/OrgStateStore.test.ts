/**
 * [enterprise] C1/C5 OrgStateStore 单元测试
 * 本地状态持久化：org 技能安装记录（version/contentHash/skillId/folderName/enabled）。
 * 纯文件逻辑，用临时目录跑真实 IO。
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applicationMock } = vi.hoisted(() => {
  const applicationMock = { getPath: vi.fn() }
  return { applicationMock }
})

vi.mock('@application', () => ({
  application: applicationMock
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })
  }
}))

import { OrgStateStore } from '@main/enterprise/OrgStateStore'

describe('OrgStateStore', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'org-state-test-'))
    applicationMock.getPath.mockImplementation((key: string) => {
      if (key === 'feature.agents.skills') return join(tmp, 'Skills')
      throw new Error(`unexpected getPath key: ${key}`)
    })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('初始状态为空 map（文件不存在）', () => {
    const store = new OrgStateStore()
    expect(store.get('any-slug')).toBeUndefined()
    expect(Object.keys(store.snapshot()).length).toBe(0)
  })

  it('upsert 后 get 返回记录并持久化到文件', () => {
    const store = new OrgStateStore()
    store.upsert('demo-skill', { version: '1.0.0', contentHash: 'abc123', skillId: 's1', folderName: 'demo-skill' })

    expect(store.get('demo-skill')?.version).toBe('1.0.0')
    expect(store.get('demo-skill')?.enabled).toBe(true)

    // 重新加载验证持久化
    const reloaded = new OrgStateStore()
    expect(reloaded.get('demo-skill')?.contentHash).toBe('abc123')
    expect(existsSync(join(tmp, 'enterprise', 'org-state.json'))).toBe(true)
  })

  it('remove 删除记录且持久化', () => {
    const store = new OrgStateStore()
    store.upsert('demo-skill', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd' })
    store.remove('demo-skill')

    expect(store.get('demo-skill')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.get('demo-skill')).toBeUndefined()
  })

  it('setEnabled 只翻转 enabled 字段', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd', enabled: true })
    store.setEnabled('demo', false)

    expect(store.get('demo')?.enabled).toBe(false)
    expect(store.get('demo')?.skillId).toBe('s1')
  })

  it('损坏的 state 文件安全降级为空', () => {
    const entDir = join(tmp, 'enterprise')
    mkdirSync(entDir, { recursive: true })
    writeFileSync(join(entDir, 'org-state.json'), '{not json')
    const store = new OrgStateStore()
    expect(Object.keys(store.snapshot()).length).toBe(0)
  })

  it('不可用标记：markUnavailable/markAvailable', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd' })
    store.markUnavailable()
    expect(store.snapshotUnavailable()).toBe(true)

    const reloaded = new OrgStateStore()
    expect(reloaded.snapshotUnavailable()).toBe(true)
    reloaded.markAvailable()
    expect(new OrgStateStore().snapshotUnavailable()).toBe(false)
  })

  it('文件内容校验：记录字段完整', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '2.0.0', contentHash: 'cafe', skillId: 'id9', folderName: 'Demo' })
    const raw = JSON.parse(readFileSync(join(tmp, 'enterprise', 'org-state.json'), 'utf8'))
    expect(raw.skills.demo).toEqual({
      version: '2.0.0',
      contentHash: 'cafe',
      skillId: 'id9',
      folderName: 'Demo',
      enabled: true
    })
  })

  // [enterprise] C4 墓碑：删除记录移入 deletedSkills（含删除时 hash），供 startupScan
  // 防复活判断（同 hash 不重装、企业推新版 hash 变化时覆盖重装）。原 remove 逻辑保留。
  it('markDeleted 写入墓碑并持久化，含删除时 contentHash', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h1', skillId: 's1', folderName: 'd' })
    store.markDeleted('demo', 'h1')

    expect(store.deletedHash('demo')).toBe('h1')
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedHash('demo')).toBe('h1')
    // 墓碑后原记录仍在（installedSlugs 语义由 OrgSkillCatalog 过滤，store 不管）
    expect(reloaded.get('demo')?.skillId).toBe('s1')
  })

  it('clearDeleted 移除墓碑且持久化', () => {
    const store = new OrgStateStore()
    store.markDeleted('demo', 'h1')
    store.clearDeleted('demo')

    expect(store.deletedHash('demo')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedHash('demo')).toBeUndefined()
  })

  it('markDeleted 幂等：重复标记以后一次 hash 为准', () => {
    const store = new OrgStateStore()
    store.markDeleted('demo', 'h1')
    store.markDeleted('demo', 'h2')
    expect(store.deletedHash('demo')).toBe('h2')
  })
})
