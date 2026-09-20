import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  installMock,
  uninstallMock,
  installFromZipMock,
  installFromDirectoryMock,
  listLocalMock,
  discoverSystemMock,
  getByIdMock,
  getInstalledSkillDirectoryMock,
  importSystemMock,
  openPathMock,
  reconcileMock,
  resolveIconUrlsMock,
  appGetOptionalMock,
  appGetExistingMock,
  reportDeletedMock,
  orgSnapshotMock
} = vi.hoisted(() => ({
  installMock: vi.fn(),
  uninstallMock: vi.fn(),
  installFromZipMock: vi.fn(),
  installFromDirectoryMock: vi.fn(),
  listLocalMock: vi.fn(),
  discoverSystemMock: vi.fn(),
  getByIdMock: vi.fn(),
  getInstalledSkillDirectoryMock: vi.fn(),
  importSystemMock: vi.fn(),
  openPathMock: vi.fn(),
  reconcileMock: vi.fn(),
  resolveIconUrlsMock: vi.fn(),
  // [enterprise] C4 拦截层用例：getOptional 对非 conditional 服务抛错（真实容器契约），
  // getExisting 只在已创建时解析——拦截层必须用后者
  appGetOptionalMock: vi.fn(),
  appGetExistingMock: vi.fn(),
  reportDeletedMock: vi.fn(),
  orgSnapshotMock: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { openPath: openPathMock }
}))

// [enterprise] 真实容器契约：非 conditional 服务 getOptional 抛错
vi.mock('@application', () => ({
  application: {
    getOptional: appGetOptionalMock,
    getExisting: appGetExistingMock
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('@main/enterprise/OrgStateStore', () => ({
  orgStateStore: { snapshot: orgSnapshotMock }
}))

// [enterprise] EnterprisePlugin 非 conditional（普通 @Injectable），getOptional 必须抛错
appGetOptionalMock.mockImplementation(() => {
  throw new Error("[ServiceContainer] Service 'EnterprisePlugin' is not conditional — use get('EnterprisePlugin').")
})

vi.mock('@main/ai/skills/SkillService', () => ({
  skillService: {
    install: installMock,
    uninstall: uninstallMock,
    installFromZip: installFromZipMock,
    installFromDirectory: installFromDirectoryMock,
    listLocal: listLocalMock,
    discoverSystem: discoverSystemMock,
    getById: getByIdMock,
    getInstalledSkillDirectory: getInstalledSkillDirectoryMock,
    importSystem: importSystemMock,
    reconcileSkills: reconcileMock,
    resolveIconUrls: resolveIconUrlsMock
  }
}))

import { skillHandlers } from '../skill'

const ctx = { senderId: 'w1' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('skillHandlers', () => {
  it('install wraps the installed skill in a success envelope', async () => {
    installMock.mockResolvedValue({ id: 's1' })
    expect(await skillHandlers['skill.install']({ installSource: 'src' }, ctx)).toEqual({
      success: true,
      data: { id: 's1' }
    })
    expect(installMock).toHaveBeenCalledWith({ installSource: 'src' })
  })

  it('install returns a failure envelope (and swallows the throw) on error', async () => {
    installMock.mockRejectedValue(new Error('boom'))
    expect(await skillHandlers['skill.install']({ installSource: 'src' }, ctx)).toEqual({
      success: false,
      error: 'boom'
    })
  })

  it('uninstall forwards the skillId and returns a void success envelope', async () => {
    uninstallMock.mockResolvedValue(undefined)
    expect(await skillHandlers['skill.uninstall']({ skillId: 's1' }, ctx)).toEqual({ success: true, data: undefined })
    expect(uninstallMock).toHaveBeenCalledWith('s1')
  })

  it('install_from_zip / install_from_directory forward their path options', async () => {
    installFromZipMock.mockResolvedValue({ id: 'z' })
    installFromDirectoryMock.mockResolvedValue({ id: 'd' })
    await skillHandlers['skill.install_from_zip']({ zipFilePath: '/a.zip' }, ctx)
    await skillHandlers['skill.install_from_directory']({ directoryPath: '/dir' }, ctx)
    expect(installFromZipMock).toHaveBeenCalledWith({ zipFilePath: '/a.zip' })
    expect(installFromDirectoryMock).toHaveBeenCalledWith({ directoryPath: '/dir' })
  })

  it('list_local forwards the workdir', async () => {
    listLocalMock.mockResolvedValue([{ name: 'a', filename: 'a.md' }])
    expect(await skillHandlers['skill.list_local']({ workdir: '/w' }, ctx)).toEqual({
      success: true,
      data: [{ name: 'a', filename: 'a.md' }]
    })
    expect(listLocalMock).toHaveBeenCalledWith('/w')
  })

  it('discover_system returns native IpcApi data without a nested SkillResult envelope', async () => {
    discoverSystemMock.mockResolvedValue([{ id: 'candidate-1' }])

    await expect(skillHandlers['skill.discover_system']({}, ctx)).resolves.toEqual([{ id: 'candidate-1' }])
    expect(discoverSystemMock).toHaveBeenCalledWith()
  })

  it('system skill routes keep discovery and import separate from agent association', async () => {
    discoverSystemMock.mockResolvedValue([])
    importSystemMock.mockResolvedValue({ id: 'system-skill' })

    await skillHandlers['skill.discover_system']({}, ctx)
    await skillHandlers['skill.import_system']({ directoryPath: '/skill' }, ctx)

    expect(discoverSystemMock).toHaveBeenCalledWith()
    expect(importSystemMock).toHaveBeenCalledWith({ directoryPath: '/skill' })
  })

  it('reconcile delegates to SkillService.reconcileSkills with the native IpcApi contract', async () => {
    reconcileMock.mockResolvedValue(undefined)

    await expect(skillHandlers['skill.reconcile']({}, ctx)).resolves.toBeUndefined()
    expect(reconcileMock).toHaveBeenCalledWith()
  })

  it('resolves skill icons from ids without accepting renderer paths', async () => {
    resolveIconUrlsMock.mockResolvedValue({ s1: 'file:///managed/icon.png' })

    await expect(skillHandlers['skill.icons.resolve']({ skillIds: ['s1'] }, ctx)).resolves.toEqual({
      s1: 'file:///managed/icon.png'
    })
    expect(resolveIconUrlsMock).toHaveBeenCalledWith(['s1'])
  })

  it('opens the registered skill directory without accepting a renderer-supplied path', async () => {
    const skill = { id: 's1', folderName: 'safe-skill' }
    getByIdMock.mockResolvedValue(skill)
    getInstalledSkillDirectoryMock.mockReturnValue('/managed/skills/safe-skill')
    openPathMock.mockResolvedValue('')

    await expect(skillHandlers['skill.folder.open']({ skillId: 's1' }, ctx)).resolves.toBeUndefined()

    expect(getByIdMock).toHaveBeenCalledWith('s1')
    expect(getInstalledSkillDirectoryMock).toHaveBeenCalledWith(skill)
    expect(openPathMock).toHaveBeenCalledWith('/managed/skills/safe-skill')
  })

  it('does not open a path when the skill is no longer installed', async () => {
    getByIdMock.mockResolvedValue(null)

    await expect(skillHandlers['skill.folder.open']({ skillId: 'missing' }, ctx)).rejects.toThrow(
      'Skill not found: missing'
    )
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('does not open a skill folder for a trusted but unmanaged renderer', async () => {
    await expect(skillHandlers['skill.folder.open']({ skillId: 's1' }, { senderId: null })).rejects.toThrow(
      'Skill folders can only be opened from a managed window'
    )
    expect(getByIdMock).not.toHaveBeenCalled()
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('reports the OS error when the managed skill directory cannot be opened', async () => {
    const skill = { id: 's1', folderName: 'missing-directory' }
    getByIdMock.mockResolvedValue(skill)
    getInstalledSkillDirectoryMock.mockReturnValue('/managed/skills/missing-directory')
    openPathMock.mockResolvedValue('The file does not exist')

    await expect(skillHandlers['skill.folder.open']({ skillId: 's1' }, ctx)).rejects.toThrow(
      'Failed to open skill folder: The file does not exist'
    )
  })

  it('import_system lets errors propagate to IpcApi', async () => {
    importSystemMock.mockRejectedValue(new Error('import failed'))

    await expect(skillHandlers['skill.import_system']({ directoryPath: '/skill' }, ctx)).rejects.toThrow(
      'import failed'
    )
  })

  // copy 模式下，安装后的技能与本地上传一致；卸载不再进入组织生命周期。
  it('uninstall of a copied organization skill only removes the local skill', async () => {
    orgSnapshotMock.mockReturnValue({
      'org-code-review': {
        version: '2.0.0',
        contentHash: 'h',
        skillId: 's-org',
        folderName: 'org-code-review',
        enabled: true
      }
    })
    uninstallMock.mockResolvedValue(undefined)

    await skillHandlers['skill.uninstall']({ skillId: 's-org' }, ctx)

    expect(appGetExistingMock).not.toHaveBeenCalled()
    expect(appGetOptionalMock).not.toHaveBeenCalled()
    expect(reportDeletedMock).not.toHaveBeenCalled()
    expect(uninstallMock).toHaveBeenCalledWith('s-org')
  })

  it('uninstall of a non-org skill skips the enterprise report entirely', async () => {
    orgSnapshotMock.mockReturnValue({})
    uninstallMock.mockResolvedValue(undefined)

    await skillHandlers['skill.uninstall']({ skillId: 's-local' }, ctx)

    expect(appGetExistingMock).not.toHaveBeenCalled()
    expect(reportDeletedMock).not.toHaveBeenCalled()
    expect(uninstallMock).toHaveBeenCalledWith('s-local')
  })

  it('uninstall does not depend on the enterprise plugin', async () => {
    orgSnapshotMock.mockReturnValue({
      'org-pdf': { version: '1.0.0', contentHash: 'h', skillId: 's-pdf', folderName: 'pdf', enabled: true }
    })
    appGetExistingMock.mockReturnValue(undefined)
    uninstallMock.mockResolvedValue(undefined)

    await skillHandlers['skill.uninstall']({ skillId: 's-pdf' }, ctx)

    expect(appGetExistingMock).not.toHaveBeenCalled()
    expect(reportDeletedMock).not.toHaveBeenCalled()
    expect(uninstallMock).toHaveBeenCalledWith('s-pdf')
  })
})
