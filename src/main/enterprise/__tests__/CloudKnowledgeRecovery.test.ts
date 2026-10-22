import { describe, expect, it, vi } from 'vitest'

import { CloudKnowledgeRecovery, type CloudRecovery, type RecoveryFile } from '../CloudKnowledgeRecovery'

const file: RecoveryFile = {
  id: 'f',
  space_id: 's',
  parent_id: null,
  name: '资料.pdf',
  is_dir: false,
  has_original_file: true,
  file_hash: 'hash',
  updated_at: 'today'
}
function setup(files = [file]) {
  let state: CloudRecovery | undefined
  const ports = {
    load: () => state,
    save: (value: CloudRecovery) => {
      state = structuredClone(value)
    },
    scan: vi.fn(async () => files),
    createBase: vi.fn(async () => 'local'),
    localCopies: vi.fn(() => [] as string[]),
    hasBase: vi.fn(async () => true),
    restore: vi.fn<
      (
        file: RecoveryFile,
        baseId: string,
        parentItemId: string | null,
        expectHash: (hash: string) => void
      ) => Promise<string | null>
    >(async (_file, _baseId, _parent, expectHash) => {
      expectHash('original-hash')
      return 'item'
    }),
    fingerprint: vi.fn<(itemId: string) => Promise<string | null>>(async () => 'original-hash'),
    hasRestoredItem: vi.fn(async () => true),
    assertReady: vi.fn(async () => {}),
    checkSpace: vi.fn(async () => true),
    deleteSpace: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    deleteLocalBase: vi.fn(async (_baseId: string) => {}),
    active: () => {}
  }
  return { ports, recovery: new CloudKnowledgeRecovery(ports) }
}

describe('删除无需恢复契约', () => {
  it('未预检时持久化可信副本后删除，成功前不清理且不调用恢复端口', async () => {
    const { ports, recovery } = setup()
    ports.deleteSpace.mockImplementation(async () => {
      expect(ports.load()).toMatchObject({ phase: 'delete-unknown', deleteLocal: true, localCopies: ['existing'] })
      expect(ports.deleteLocalBase).not.toHaveBeenCalled()
    })
    await recovery.remove('s', ['existing'], true)
    expect(ports.load()?.phase).toBe('completed')
    expect(ports.deleteLocalBase).toHaveBeenCalledWith('existing')
    for (const port of [ports.scan, ports.createBase, ports.restore, ports.assertReady, ports.fingerprint])
      expect(port).not.toHaveBeenCalled()
  })

  it('已普通取消分享的完成日志不能被误报为删除完成', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    await recovery.cancel(false, true)
    await expect(recovery.remove('s', ['existing'], true)).rejects.toThrow('从本机知识库删除')
    expect(ports.deleteLocalBase).not.toHaveBeenCalled()
  })

  it('跨端没有副本直接完成，不创建库或将空 ID 当成本机库删除', async () => {
    const { ports, recovery } = setup()
    expect(await recovery.remove('s', [], true)).toBe('')
    expect(ports.load()?.phase).toBe('completed')
    expect(ports.createBase).not.toHaveBeenCalled()
    expect(ports.deleteLocalBase).not.toHaveBeenCalled()
  })

  it('核查确认云端空间已删除后继续本地收尾', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.deleteSpace.mockRejectedValueOnce(new Error('timeout'))
    ports.checkSpace.mockResolvedValue(false)

    await expect(recovery.cancel(false, true)).resolves.toBe('local')
    expect(ports.load()?.phase).toBe('completed')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
  })

  it('删除请求超时但核查确认空间已消失时立即继续本地收尾', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.deleteSpace.mockRejectedValueOnce(new Error('timeout'))
    ports.checkSpace.mockResolvedValue(false)

    await expect(recovery.cancel(false, true)).resolves.toBe('local')
    expect(ports.load()?.phase).toBe('completed')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
  })

  it('删除知识库请求超时但核查确认空间已消失时继续本地清理', async () => {
    const { ports, recovery } = setup()
    ports.deleteSpace.mockRejectedValueOnce(new Error('timeout'))
    ports.checkSpace.mockResolvedValue(false)

    await expect(recovery.remove('s', ['existing'], true)).resolves.toBe('existing')
    expect(ports.load()?.phase).toBe('completed')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.deleteLocalBase).toHaveBeenCalledWith('existing')
  })

  it('核查发现云端空间仍存在时保留待核查状态', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.deleteSpace.mockRejectedValueOnce(new Error('timeout'))

    await expect(recovery.cancel(false, true)).rejects.toThrow('待核查')

    await expect(recovery.confirmDeleteResult()).rejects.toThrow('仍存在')
    expect(ports.load()?.phase).toBe('delete-unknown')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'offline', 'HTTP 500'])('未知结果 %s 不清理，重启禁止重发', async (message) => {
    const { ports, recovery } = setup()
    ports.deleteSpace.mockRejectedValue(new Error(message))
    ports.checkSpace.mockRejectedValue(new Error('check failed'))
    await expect(recovery.remove('s', ['existing'], true)).rejects.toThrow('待核查')
    await expect(new CloudKnowledgeRecovery(ports).remove('s', ['existing'], true)).rejects.toThrow('待核查')
    expect(ports.load()?.phase).toBe('delete-unknown')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.deleteLocalBase).not.toHaveBeenCalled()
  })

  it('清理失败重启只续作本机，旧日志真实恢复 ID 也被清理', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.scan.mockClear()
    ports.deleteLocalBase.mockRejectedValueOnce(new Error('cleanup'))
    await expect(recovery.remove('s', ['existing'], true)).rejects.toThrow('cleanup')
    expect(ports.load()?.phase).toBe('local-cleanup')
    await new CloudKnowledgeRecovery(ports).remove('s', [], false)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.deleteLocalBase).toHaveBeenCalledWith('local')
    expect(ports.deleteLocalBase).toHaveBeenCalledWith('existing')
    expect(ports.scan).not.toHaveBeenCalled()
  })

  it('切号后先保存原账号成功结果，恢复原账号只清理本机', async () => {
    const { ports, recovery } = setup()
    let active = true
    ports.active = () => {
      if (!active) throw new Error('account changed')
    }
    ports.deleteSpace.mockImplementation(async () => {
      active = false
    })
    await expect(recovery.remove('s', ['existing'], true)).rejects.toThrow('account changed')
    expect(ports.load()?.phase).toBe('deleted')
    expect(ports.deleteLocalBase).not.toHaveBeenCalled()
    active = true
    await new CloudKnowledgeRecovery(ports).remove('s', [], false)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.load()?.phase).toBe('completed')
  })

  it('未确认设备影响不发送删除，旧未知日志不得迁移重发', async () => {
    const { ports, recovery } = setup()
    await expect(recovery.remove('s', [], false)).rejects.toThrow('确认')
    await recovery.prepare('s')
    const state = ports.load()!
    ports.save({ ...state, deleteLocal: true, phase: 'delete-unknown' })
    await expect(recovery.remove('s', [], true)).rejects.toThrow('待核查')
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })
})

describe('取消分享恢复安全契约', () => {
  it('删除意图先于云端删除落盘，使用实际恢复 ID，重启仅重试本机清理', async () => {
    const { ports, recovery } = setup()
    ports.createBase.mockResolvedValue('restored-on-this-device')
    await recovery.prepare('s')
    ports.deleteSpace.mockImplementation(async () => {
      expect(ports.load()?.deleteLocal).toBe(true)
    })
    ports.deleteLocalBase.mockRejectedValueOnce(new Error('local cleanup failed'))
    await expect(recovery.cancel(false, true, true)).rejects.toThrow('local cleanup failed')
    expect(ports.load()?.phase).toBe('local-cleanup')
    await new CloudKnowledgeRecovery(ports).cancel(false, false)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.deleteLocalBase).toHaveBeenNthCalledWith(2, 'restored-on-this-device')
    expect(ports.load()?.phase).toBe('completed')
  })

  it('普通取消保留云端恢复内容并清理原本机副本', async () => {
    const normal = setup()
    normal.ports.localCopies.mockReturnValue(['existing'])
    await normal.recovery.prepare('s')
    await normal.recovery.cancel(false, true)
    expect(normal.ports.finish).toHaveBeenCalledWith('local', undefined)
    expect(normal.ports.deleteLocalBase).toHaveBeenCalledWith('existing')
    expect(normal.ports.deleteLocalBase).not.toHaveBeenCalledWith('local')

    const remoteOnly = setup()
    await remoteOnly.recovery.prepare('s')
    await remoteOnly.recovery.cancel(false, true)
    expect(remoteOnly.ports.deleteLocalBase).not.toHaveBeenCalled()
  })

  it('未知删除和未确认缺失均不能清理本机', async () => {
    const unknown = setup()
    await unknown.recovery.prepare('s')
    unknown.ports.deleteSpace.mockRejectedValue(new Error('timeout'))
    unknown.ports.checkSpace.mockRejectedValue(new Error('check failed'))
    await expect(unknown.recovery.cancel(false, true, true)).rejects.toThrow('待核查')
    await expect(new CloudKnowledgeRecovery(unknown.ports).cancel(true, true, true)).rejects.toThrow('待核查')
    expect(unknown.ports.deleteLocalBase).not.toHaveBeenCalled()
    const missing = setup()
    missing.ports.restore.mockResolvedValue(null)
    await missing.recovery.prepare('s')
    await expect(missing.recovery.cancel(false, true, true)).rejects.toThrow('确认')
    expect(missing.ports.deleteLocalBase).not.toHaveBeenCalled()
  })

  it('远端删除后切号不清理本机，原账号续作不重发云端删除', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    let active = true
    ports.active = () => {
      if (!active) throw new Error('account changed')
    }
    ports.deleteSpace.mockImplementation(async () => {
      active = false
    })
    await expect(recovery.cancel(false, true, true)).rejects.toThrow('account changed')
    expect(ports.deleteLocalBase).not.toHaveBeenCalled()
    active = true
    await new CloudKnowledgeRecovery(ports).cancel(false, false)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.deleteLocalBase).toHaveBeenCalledWith('local')
  })
  it('下载或磁盘失败时不允许删除云端', async () => {
    const { ports, recovery } = setup()
    ports.restore.mockRejectedValue(new Error('ENOSPC'))
    await expect(recovery.prepare('s')).rejects.toThrow('ENOSPC')
    await expect(recovery.cancel(true, true)).rejects.toThrow()
    expect(ports.deleteSpace).not.toHaveBeenCalled()
    expect(ports.load()?.phase).toBe('preparing')
  })
  it('空库和空目录均可恢复，目录不依赖文件存在', async () => {
    const empty = setup([])
    expect((await empty.recovery.prepare('s')).restored).toEqual({})
    const directory = setup([{ ...file, id: 'dir', is_dir: true, has_original_file: false }])
    expect((await directory.recovery.prepare('s')).restored).toEqual({ dir: 'item' })
    expect(directory.ports.restore).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dir' }),
      'local',
      null,
      expect.any(Function)
    )
  })

  it('复制前可信hash已落盘；复制失败后重启不能删除', async () => {
    const { ports, recovery } = setup()
    ports.restore.mockImplementation(async (_file, _base, _parent, expectHash) => {
      expectHash('trusted-source')
      expect(ports.load()?.expectedHashes.f).toBe('trusted-source')
      throw new Error('copy failed')
    })
    await expect(recovery.prepare('s')).rejects.toThrow('copy failed')
    await expect(new CloudKnowledgeRecovery(ports).cancel(true, true)).rejects.toThrow()
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })

  it('旧日志仅有目标指纹时不得将它认定为可信预期hash', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    const state = ports.load()!
    state.expectedHashes = {}
    ports.save(state)
    await expect(new CloudKnowledgeRecovery(ports).cancel(true, true)).rejects.toThrow('禁止删除')
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })

  it('恢复日志引用的本地知识库已不存在时创建新库并重新导入', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.hasBase.mockResolvedValue(false)
    ports.createBase.mockResolvedValueOnce('replacement-base')
    ports.restore.mockImplementationOnce(async (_file, _baseId, _parent, expectHash) => {
      expectHash('original-hash')
      return 'replacement-item'
    })
    const state = await new CloudKnowledgeRecovery(ports).prepare('s')
    expect(state).toMatchObject({ localBaseId: 'replacement-base', restored: { f: 'replacement-item' } })
    expect(ports.restore).toHaveBeenLastCalledWith(file, 'replacement-base', null, expect.any(Function))
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })

  it('恢复日志引用的本地条目已不存在时重新导入', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.hasRestoredItem.mockResolvedValue(false)
    ports.restore.mockImplementationOnce(async (_file, _baseId, _parent, expectHash) => {
      expectHash('original-hash')
      return 'replacement'
    })
    await new CloudKnowledgeRecovery(ports).prepare('s')
    expect(ports.restore).toHaveBeenCalledTimes(2)
    expect(ports.load()?.restored).toEqual({ f: 'replacement' })
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })

  it('恢复中断后复用同一本地知识库并只继续未完成文件', async () => {
    const files = [file, { ...file, id: 'g', name: '第二份.pdf' }]
    const { ports, recovery } = setup(files)
    ports.restore
      .mockImplementationOnce(async (_file, _baseId, _parent, expectHash) => {
        expectHash('original-hash')
        return 'first-item'
      })
      .mockImplementationOnce(async (_file, _baseId, _parent, expectHash) => {
        expectHash('original-hash')
        throw new Error('copy interrupted')
      })
      .mockResolvedValueOnce('second-item')

    await expect(recovery.prepare('s')).rejects.toThrow('copy interrupted')
    expect(ports.load()).toMatchObject({ localBaseId: 'local', restored: { f: 'first-item' }, phase: 'preparing' })
    expect(ports.createBase).toHaveBeenCalledTimes(1)

    const resumed = await new CloudKnowledgeRecovery(ports).prepare('s')
    expect(resumed.restored).toEqual({ f: 'first-item', g: 'second-item' })
    expect(ports.createBase).toHaveBeenCalledTimes(1)
    expect(ports.restore).toHaveBeenCalledTimes(3)
  })

  it('本地解析未完成不阻止恢复预检或取消分享', async () => {
    const { ports, recovery } = setup()
    ports.assertReady.mockRejectedValue(new Error('资料尚未解析完成'))

    const prepared = await recovery.prepare('s')
    expect(prepared.phase).toBe('ready')
    expect(ports.assertReady).not.toHaveBeenCalled()

    await recovery.cancel(false, true)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.assertReady).not.toHaveBeenCalled()
  })
  it('缺失原件必须独立确认，并确认其他设备停止', async () => {
    const { ports, recovery } = setup([{ ...file, has_original_file: false }])
    ports.restore.mockResolvedValue(null)
    expect((await recovery.prepare('s')).missing).toEqual([{ id: 'f', name: '资料.pdf' }])
    await expect(recovery.cancel(false, true)).rejects.toThrow('确认')
    await expect(recovery.cancel(true, false)).rejects.toThrow('确认')
    expect(await recovery.cancel(true, true)).toBe('local')
    expect(ports.load()?.phase).toBe('completed')
  })
  it('删除响应丢失持久化未知状态，重启后不得重发', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.deleteSpace.mockRejectedValue(new Error('timeout'))
    ports.checkSpace.mockRejectedValue(new Error('check failed'))
    await expect(recovery.cancel(false, true)).rejects.toThrow('待核查')
    expect(ports.load()?.phase).toBe('delete-unknown')
    await expect(new CloudKnowledgeRecovery(ports).cancel(true, true)).rejects.toThrow('待核查')
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
  })
  it('最终提交失败保留可信删除结果，续作只提交本地', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.finish.mockRejectedValueOnce(new Error('db'))
    await expect(recovery.cancel(false, true)).rejects.toThrow('db')
    expect(ports.load()?.phase).toBe('deleted')
    await new CloudKnowledgeRecovery(ports).cancel(false, false)
    expect(ports.deleteSpace).toHaveBeenCalledTimes(1)
    expect(ports.load()?.phase).toBe('completed')
  })
  it('预检后本地恢复原件被修改时阻止删除', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.fingerprint.mockResolvedValue('modified-hash')
    await expect(recovery.cancel(false, true)).rejects.toThrow('本地恢复副本已变化')
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })
  it('最后核对发现跨设备新增后阻止删除', async () => {
    const { ports, recovery } = setup()
    await recovery.prepare('s')
    ports.scan.mockResolvedValue([file, { ...file, id: 'new' }])
    await expect(recovery.cancel(false, true)).rejects.toThrow('变化')
    expect(ports.deleteSpace).not.toHaveBeenCalled()
  })
  it('空目录先于子文件恢复，名称不作为身份', async () => {
    const directory = { ...file, id: 'dir', is_dir: true }
    const { ports, recovery } = setup([{ ...file, parent_id: 'dir' }, directory])
    ports.restore.mockImplementation(async (entry, _baseId, _parent, expectHash) => {
      expectHash('original-hash')
      return entry.id + '-local'
    })
    const result = await recovery.prepare('s')
    expect(result.restored).toEqual({ dir: 'dir-local', f: 'f-local' })
    expect(ports.restore.mock.calls[0][0].id).toBe('dir')
  })
})
