/**
 * [enterprise] C1/C2/C4 OrgSkillCatalog 扩展单元测试
 * - startupScan: content_hash 比对 → 自动更新（C1）+ 目录缺失标记停用（C2）
 * - listDisabled: 停用拦截（C2）
 * - reportDeleted: 删除上报（C4）
 * mock 掉 auth/apiClient/SkillService/OrgStateStore，只测编排逻辑。
 * 每个用例新建实例（避免 catalogCache 跨用例泄漏）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authMock, apiMock, skillServiceMock, stateStoreMock } = vi.hoisted(() => ({
  authMock: {},
  apiMock: {
    listSkills: vi.fn(),
    reportLifecycle: vi.fn()
  },
  skillServiceMock: {
    installSkillDir: vi.fn(),
    list: vi.fn(),
    uninstall: vi.fn()
  },
  stateStoreMock: {
    upsert: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
    snapshot: vi.fn(),
    setEnabled: vi.fn(),
    markUnavailable: vi.fn(),
    markAvailable: vi.fn(),
    snapshotUnavailable: vi.fn(),
    // [enterprise] C4 墓碑 API
    markDeleted: vi.fn(),
    clearDeleted: vi.fn(),
    deletedHash: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('@main/ai/skills/SkillService', () => ({
  skillService: skillServiceMock
}))

vi.mock('@main/enterprise/OrgStateStore', () => ({
  orgStateStore: stateStoreMock,
  OrgStateStore: class {}
}))

import { OrgSkillCatalog } from '@main/enterprise/OrgSkillCatalog'

function makeItem(slug: string, contentHash: string, version = '1.0.0') {
  return {
    slug,
    name: slug,
    description: `${slug} desc`,
    version,
    contentHash,
    downloadUrl: `/api/skills/${slug}/download`
  }
}

describe('OrgSkillCatalog C1/C2/C4', () => {
  let catalog: OrgSkillCatalog

  beforeEach(() => {
    vi.resetAllMocks()
    // 重置默认实现（resetAllMocks 会清掉 mockReturnValue）
    apiMock.reportLifecycle.mockResolvedValue(undefined)
    stateStoreMock.snapshot.mockReturnValue({})
    catalog = new OrgSkillCatalog(authMock as never)
    ;(catalog as unknown as { auth: { apiClient: unknown } }).auth = { apiClient: apiMock }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('C1 startupScan：hash 一致 → 跳过更新', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-a')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1.0.0', contentHash: 'hash-a', skillId: 's1', folderName: 'a', enabled: true }
    })

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(result.updated).toEqual([])
    expect(result.disabled).toEqual([])
  })

  it('C1 startupScan：hash 不一致 → 重新下载安装并刷新 state', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-a2', '2.0.0')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1.0.0', contentHash: 'hash-a', skillId: 's1', folderName: 'a', enabled: true }
    })

    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(downloadAndInstall).toHaveBeenCalledWith('a', expect.objectContaining({ slug: 'a', contentHash: 'hash-a2' }))
    expect(result.updated).toEqual(['a'])
  })

  it('C1 startupScan：本地无记录 → 视为新技能安装', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('b', 'hash-b')] })
    stateStoreMock.snapshot.mockReturnValue({})

    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(downloadAndInstall).toHaveBeenCalledWith('b', expect.anything())
    expect(result.updated).toEqual(['b'])
  })

  it('C1 startupScan：单项更新失败不阻塞其余项', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'ha2'), makeItem('b', 'hb2')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1', contentHash: 'ha', skillId: 's1', folderName: 'a', enabled: true },
      b: { version: '1', contentHash: 'hb', skillId: 's2', folderName: 'b', enabled: true }
    })

    let call = 0
    const downloadAndInstall = vi.fn().mockImplementation(() => {
      call += 1
      if (call === 1) throw new Error('download failed')
      return Promise.resolve()
    })
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(result.updated).toEqual(['b'])
  })

  it('C1 startupScan：目录不可达 → 返回空结果不抛错', async () => {
    apiMock.listSkills.mockRejectedValue(new Error('network down'))
    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(result.updated).toEqual([])
    expect(result.disabled).toEqual([])
  })

  it('C2 startupScan：本地有但目录没有 → 标记停用（不卸载文件）', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [] })
    stateStoreMock.snapshot.mockReturnValue({
      old: { version: '1', contentHash: 'h', skillId: 's-old', folderName: 'old', enabled: true }
    })

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(result.disabled).toEqual(['old'])
    expect(skillServiceMock.uninstall).not.toHaveBeenCalled() // 保留本地文件，只拦截
    expect(stateStoreMock.setEnabled).toHaveBeenCalledWith('old', false)
  })

  it('C2 startupScan：远端恢复下发 → 清除停用标记', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-a')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1', contentHash: 'hash-a', skillId: 's1', folderName: 'a', enabled: false }
    })

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(stateStoreMock.setEnabled).toHaveBeenCalledWith('a', true)
    expect(result.disabled).toEqual([])
  })

  it('C2 listDisabled：目录齐全且启用 → 空集合', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-a')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1', contentHash: 'hash-a', skillId: 's1', folderName: 'a', enabled: true }
    })
    expect(await catalog.listDisabled()).toEqual([])
  })

  it('C2 listDisabled：目录缺失或 enabled=false → 出现在停用列表', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-a')] })
    stateStoreMock.snapshot.mockReturnValue({
      a: { version: '1', contentHash: 'hash-a', skillId: 's1', folderName: 'a', enabled: true },
      gone: { version: '1', contentHash: 'hg', skillId: 's2', folderName: 'g', enabled: true },
      off: { version: '1', contentHash: 'ho', skillId: 's3', folderName: 'o', enabled: false }
    })
    const disabled = await catalog.listDisabled()
    expect(disabled.sort()).toEqual(['gone', 'off'])
  })

  it('C2 listDisabled：目录拉取失败且无缓存 → 抛错（fail-open 由调用方决定）', async () => {
    apiMock.listSkills.mockRejectedValue(new Error('network down'))
    await expect(catalog.listDisabled()).rejects.toThrow('network down')
  })

  it('C2 list()：TTL 内走缓存不再发请求；过期后重新拉取', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'h1')] })
    await catalog.list()
    await catalog.list()
    expect(apiMock.listSkills).toHaveBeenCalledTimes(1) // TTL 内命中缓存

    // 模拟过期
    ;(catalog as unknown as { catalogCache: { at: number } | null }).catalogCache!.at = Date.now() - 6 * 60 * 1000
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'h2')] })
    const items = await catalog.list()
    expect(apiMock.listSkills).toHaveBeenCalledTimes(2)
    expect(items[0].contentHash).toBe('h2')
  })

  it('C2 list()：拉取失败但有过期缓存 → 降级返回旧目录', async () => {
    apiMock.listSkills.mockResolvedValueOnce({ skills: [makeItem('a', 'h1')] })
    await catalog.list()
    ;(catalog as unknown as { catalogCache: { at: number } | null }).catalogCache!.at = Date.now() - 6 * 60 * 1000

    apiMock.listSkills.mockRejectedValueOnce(new Error('down'))
    const items = await catalog.list()
    expect(items.map((i) => i.slug)).toEqual(['a'])
  })

  // [enterprise] 管理台启停后客户端「刷新」必须穿透 TTL 缓存，否则 5 分钟内看不到变更
  it('C2 list(force)：TTL 内强制刷新重新拉取并更新缓存', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'h1')] })
    await catalog.list()

    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'h2')] })
    const items = await catalog.list(true)
    expect(apiMock.listSkills).toHaveBeenCalledTimes(2)
    expect(items[0].contentHash).toBe('h2')

    // 强刷后缓存被新数据替换，后续普通调用命中新缓存
    await catalog.list()
    expect(apiMock.listSkills).toHaveBeenCalledTimes(2)
  })

  it('C2 list(force)：强刷失败仍有旧缓存 → 降级返回旧目录', async () => {
    apiMock.listSkills.mockResolvedValueOnce({ skills: [makeItem('a', 'h1')] })
    await catalog.list()

    apiMock.listSkills.mockRejectedValueOnce(new Error('down'))
    const items = await catalog.list(true)
    expect(items.map((i) => i.slug)).toEqual(['a'])
  })

  it('C4 reportDeleted：调用 lifecycle deleted 上报 + 清 state', async () => {
    await catalog.reportDeleted('a')
    expect(apiMock.reportLifecycle).toHaveBeenCalledWith('a', 'deleted', expect.anything())
    expect(stateStoreMock.remove).toHaveBeenCalledWith('a')
  })

  it('C4 reportDeleted：上报失败仍清 state（不阻塞本地卸载）', async () => {
    apiMock.reportLifecycle.mockRejectedValue(new Error('report failed'))
    await expect(catalog.reportDeleted('a')).rejects.toThrow('report failed')
    expect(stateStoreMock.remove).toHaveBeenCalledWith('a')
  })

  it('C1 install 成功后写入 state（slug → contentHash/skillId/folderName）', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('new-skill', 'hash-new')] })

    const installSkillDir = vi.fn().mockResolvedValue({ id: 'sk-1', folderName: 'new-skill' })
    // 动态 import('@main/ai/skills/SkillService') 拿到的是 mock 的 skillService
    skillServiceMock.installSkillDir = installSkillDir

    // 拦截真实下载与 tar 解包：替换私有方法 + mock execFileAsync（模块级 promisify 结果）
    const downloadWithHash = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadWithHash: unknown }).downloadWithHash = downloadWithHash
    const tar = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    ;(catalog as unknown as { tarExtract: unknown }).tarExtract = tar

    await catalog.install('new-skill')
    expect(installSkillDir).toHaveBeenCalledWith(
      expect.stringContaining('new-skill'),
      'org',
      'org-skill:new-skill',
      expect.anything()
    )
    expect(stateStoreMock.upsert).toHaveBeenCalledWith(
      'new-skill',
      expect.objectContaining({ contentHash: 'hash-new', skillId: 'sk-1', folderName: 'new-skill' })
    )
    expect(apiMock.reportLifecycle).toHaveBeenCalledWith('new-skill', 'install', { version: '1.0.0' })
  })

  // [enterprise] 显示名修复：服务端目录 name（如「企业代码评审规范」）必须作为 displayName
  // 传入安装链路，否则「我安装的」列表回退到 SKILL.md frontmatter 的 name（slug 形态）
  it('install：服务端目录 name/description 作为 catalogDisplayMetadata 传入安装', async () => {
    apiMock.listSkills.mockResolvedValue({
      skills: [{ ...makeItem('org-code-review', 'hash-x'), name: '企业代码评审规范', description: '评审描述' }]
    })

    const installSkillDir = vi.fn().mockResolvedValue({ id: 'sk-2', folderName: 'org-code-review' })
    skillServiceMock.installSkillDir = installSkillDir
    ;(catalog as unknown as { downloadWithHash: unknown }).downloadWithHash = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { tarExtract: unknown }).tarExtract = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await catalog.install('org-code-review')
    expect(installSkillDir).toHaveBeenCalledWith(
      expect.anything(),
      'org',
      'org-skill:org-code-review',
      expect.objectContaining({
        catalogDisplayMetadata: expect.objectContaining({
          displayName: '企业代码评审规范',
          description: '评审描述'
        })
      })
    )
  })

  it('[enterprise] installedSlugs：返回 state 中已装的 slug 列表', () => {
    stateStoreMock.snapshot.mockReturnValue({
      'installed-a': { version: '1.0.0', contentHash: 'h1', skillId: 'id-1', folderName: 'installed-a', enabled: true },
      'installed-b': { version: '2.0.0', contentHash: 'h2', skillId: 'id-2', folderName: 'installed-b', enabled: false }
    })
    expect(catalog.installedSlugs()).toEqual(['installed-a', 'installed-b'])
  })

  it('[enterprise] installedSlugs：无安装记录时返回空数组', () => {
    stateStoreMock.snapshot.mockReturnValue({})
    expect(catalog.installedSlugs()).toEqual([])
  })

  // [enterprise] C4 墓碑：删除后 installedSlugs 不得再包含该 slug（否则组织 tab 永远「已安装」）
  it('C4 installedSlugs：排除已删除（墓碑）的 slug', () => {
    stateStoreMock.snapshot.mockReturnValue({
      kept: { version: '1', contentHash: 'hk', skillId: 's1', folderName: 'kept', enabled: true },
      gone: { version: '1', contentHash: 'hg', skillId: 's2', folderName: 'gone', enabled: true }
    })
    stateStoreMock.deletedHash.mockImplementation((slug: string) => (slug === 'gone' ? 'hg' : undefined))
    expect(catalog.installedSlugs()).toEqual(['kept'])
  })

  // [enterprise] C4 闭环：已删技能重新安装后墓碑必须清除，否则 installedSlugs 永远排除它，
  // 组织 tab 永远显示可点的「安装」按钮、每次点击都重装成功（用户报障场景）。
  it('C4 install：已删除（有墓碑）的技能重新安装 → 清墓碑且 installedSlugs 重新纳入', async () => {
    // 内存版 state 假件，让 installedSlugs() 反射真实增删语义
    const states: Record<string, Record<string, unknown>> = {}
    const tombstones: Record<string, string> = {}
    stateStoreMock.upsert.mockImplementation((slug: string, s: Record<string, unknown>) => {
      states[slug] = s
    })
    stateStoreMock.remove.mockImplementation((slug: string) => {
      delete states[slug]
    })
    stateStoreMock.snapshot.mockImplementation(() => states)
    stateStoreMock.markDeleted.mockImplementation((slug: string, h: string) => {
      tombstones[slug] = h
    })
    stateStoreMock.clearDeleted.mockImplementation((slug: string) => {
      delete tombstones[slug]
    })
    stateStoreMock.deletedHash.mockImplementation((slug: string) => tombstones[slug])

    // 模拟用户曾删除：留下墓碑（state 已被卸载链路移除）
    tombstones['reborn'] = 'hash-old'
    expect(catalog.installedSlugs()).toEqual([])

    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('reborn', 'hash-r')] })
    const installSkillDir = vi.fn().mockResolvedValue({ id: 'sk-9', folderName: 'reborn' })
    skillServiceMock.installSkillDir = installSkillDir
    ;(catalog as unknown as { downloadWithHash: unknown }).downloadWithHash = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { tarExtract: unknown }).tarExtract = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await catalog.install('reborn')

    // 契约：重新安装 = 用户意图变更 → 墓碑必须清除，installedSlugs 必须重新纳入
    expect(stateStoreMock.clearDeleted).toHaveBeenCalledWith('reborn')
    expect(catalog.installedSlugs()).toContain('reborn')
  })

  it('C4 reportDeleted：上报后写墓碑（记录删除时 hash）并清安装记录', async () => {
    apiMock.reportLifecycle.mockResolvedValue(undefined)

    await catalog.reportDeleted('a')

    expect(apiMock.reportLifecycle).toHaveBeenCalledWith('a', 'deleted', expect.anything())
    expect(stateStoreMock.remove).toHaveBeenCalledWith('a')
  })

  it('C4 reportDeleted：删除时把当前 contentHash 记入墓碑（供 C1 防复活）', async () => {
    apiMock.reportLifecycle.mockResolvedValue(undefined)
    stateStoreMock.get.mockReturnValue({
      version: '1.0.0',
      contentHash: 'hash-deleted-at',
      skillId: 's1',
      folderName: 'a',
      enabled: true
    })

    await catalog.reportDeleted('a')

    expect(stateStoreMock.markDeleted).toHaveBeenCalledWith('a', 'hash-deleted-at')
  })

  // [enterprise] C1 防复活：用户删过的技能（墓碑 hash 一致）重启后不得自动重装
  it('C1 startupScan：墓碑 hash 与远端一致 → 跳过重装（删除不被复活）', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-deleted-at')] })
    stateStoreMock.snapshot.mockReturnValue({})
    stateStoreMock.deletedHash.mockImplementation((slug: string) => (slug === 'a' ? 'hash-deleted-at' : undefined))

    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(result.updated).toEqual([])
  })

  // 企业推新版（hash 变化）→ 用户删除意图失效，清墓碑重新下发
  it('C1 startupScan：墓碑 hash 与远端不一致 → 清墓碑并重装（新版下发）', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('a', 'hash-new', '2.0.0')] })
    stateStoreMock.snapshot.mockReturnValue({})
    stateStoreMock.deletedHash.mockImplementation((slug: string) => (slug === 'a' ? 'hash-old' : undefined))

    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(stateStoreMock.clearDeleted).toHaveBeenCalledWith('a')
    expect(downloadAndInstall).toHaveBeenCalledWith('a', expect.objectContaining({ contentHash: 'hash-new' }))
    expect(result.updated).toEqual(['a'])
  })

  // 无墓碑时行为不变：远端有、本地无 → 视为新技能安装
  it('C1 startupScan：远端有本地无且无墓碑 → 正常安装（原语义保留）', async () => {
    apiMock.listSkills.mockResolvedValue({ skills: [makeItem('fresh', 'hash-f')] })
    stateStoreMock.snapshot.mockReturnValue({})
    stateStoreMock.deletedHash.mockReturnValue(undefined)

    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    ;(catalog as unknown as { downloadAndInstall: unknown }).downloadAndInstall = downloadAndInstall

    const result = await (catalog as unknown as { startupScan: () => Promise<{ updated: string[]; disabled: string[] }> }).startupScan()
    expect(stateStoreMock.clearDeleted).not.toHaveBeenCalled()
    expect(downloadAndInstall).toHaveBeenCalledWith('fresh', expect.anything())
    expect(result.updated).toEqual(['fresh'])
  })
})
