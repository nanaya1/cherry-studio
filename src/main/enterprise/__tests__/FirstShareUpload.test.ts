import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FirstShareUpload } from '../FirstShareUpload'
import { OrgApiHttpError } from '../OrgApiClient'

const entry = {
  itemId: 'i',
  fileName: '原文.txt',
  path: '/file',
  size: 10,
  hash: 'hash',
  fingerprint: 'fp',
  chunks: [{ content: '正文' }]
}
let saved: any
const store = {
  get: () => structuredClone(saved),
  set: (_key: string, value: unknown) => {
    saved = structuredClone(value)
  }
}
// const client = { createShareSpace: vi.fn(), uploadShareStream: vi.fn(), verify: vi.fn() }
const client = {
  createShareSpace: vi.fn(),
  createShareFolder: vi.fn(),
  verifyFolder: vi.fn(),
  verifyPolicy: vi.fn(),
  uploadShareStream: vi.fn(),
  verify: vi.fn()
}
const run = () =>
  new FirstShareUpload(store, client).run(
    'key',
    '库',
    async () => [entry],
    () => {},
    () => {}
  )
beforeEach(() => {
  saved = undefined
  vi.resetAllMocks()
  client.createShareSpace.mockResolvedValue({ share_id: 'space' })
  client.uploadShareStream.mockResolvedValue({ share_id: 'space', file_id: 'file', chunk_count: 1 })
  client.verify.mockResolvedValue(undefined)
})
it('创建前持久化库级false，创建与每次上传前核验真实策略', async () => {
  client.createShareSpace.mockImplementation(async (_name, mode) => {
    expect(saved.uploadOriginal).toBe(false)
    expect(mode).toBe(false)
    return { share_id: 'space' }
  })
  const result = await new FirstShareUpload(store, client).run(
    'key',
    '库',
    async () => [{ ...entry, uploadOriginal: false }],
    () => {},
    () => {}
  )
  expect(result.completion).toBe('completed')
  expect(client.verifyPolicy).toHaveBeenCalledWith('space', false, true)
  expect(saved.uploadOriginal).toBe(false)
})
it('空库也在创建前持久化库级false且可恢复', async () => {
  const upload = () =>
    new FirstShareUpload(store, client).run(
      'key',
      '空库',
      async () => [],
      () => {},
      () => {},
      false,
      false
    )
  expect((await upload()).completion).toBe('completed')
  expect(saved.uploadOriginal).toBe(false)
  expect((await upload()).completion).toBe('completed')
  expect(client.createShareSpace).toHaveBeenCalledTimes(1)
  expect(client.uploadShareStream).not.toHaveBeenCalled()
})
it('策略核验失败禁止上传且保留可信空间供重试', async () => {
  client.verifyPolicy.mockRejectedValue(new Error('策略不符'))
  expect((await run()).completion).toBe('incomplete')
  expect(client.uploadShareStream).not.toHaveBeenCalled()
  expect(saved.shareId).toBe('space')
})

describe('目录分享', () => {
  const folders = [
    { itemId: 'z', fileName: '资料', parentItemId: null },
    { itemId: 'a', fileName: '合同', parentItemId: 'z' },
    { itemId: 'empty', fileName: '空目录', parentItemId: 'a' }
  ]
  const plan = async () => ({ files: [{ ...entry, parentItemId: 'a' }], folders })
  const share = (verifyOnly = false) =>
    new FirstShareUpload(store, client).run(
      'key',
      '库',
      plan,
      () => {},
      () => {},
      verifyOnly
    )
  beforeEach(() => {
    client.createShareFolder.mockImplementation(async (space, folder, parent) => {
      expect(saved.folders.find((f: any) => f.itemId === folder.itemId).phase).toBe('intent')
      return { folder_id: `remote-${folder.itemId}`, name: folder.fileName, space_id: space, parent_id: parent }
    })
  })
  it('按父子顺序创建多层及空目录，文件传入可信父目录ID', async () => {
    expect((await share()).completion).toBe('completed')
    expect(client.createShareFolder.mock.calls.map(([, f, p]) => [f.fileName, p])).toEqual([
      ['资料', null],
      ['合同', 'remote-z'],
      ['空目录', 'remote-a']
    ])
    expect(client.uploadShareStream.mock.calls[0][1]).toMatchObject({ parentId: 'remote-a' })
    expect(saved.folders.every((f: any) => f.phase === 'success')).toBe(true)
  })
  it('只有空目录也可分享，创建空间响应丢失不能误判完成', async () => {
    const upload = () =>
      new FirstShareUpload(store, client).run(
        'key',
        '库',
        async () => ({ files: [], folders }),
        () => {},
        () => {}
      )
    client.createShareSpace.mockRejectedValueOnce(new Error('断网'))
    expect((await upload()).completion).toBe('incomplete')
    saved = undefined
    expect((await upload()).completion).toBe('completed')
    expect(client.uploadShareStream).not.toHaveBeenCalled()
  })
  it.each([
    { folder_id: 'x', name: '资料', space_id: 'wrong', parent_id: null },
    { folder_id: 'x', name: '资料', space_id: 'space', parent_id: 'wrong' }
  ])('目录响应归属不符时不保存可信ID：%j', async (response) => {
    client.createShareFolder.mockResolvedValueOnce(response)
    expect((await share()).completion).toBe('incomplete')
    expect(saved.folders.find((f: any) => f.itemId === 'z').folderId).toBeNull()
    await share()
    expect(client.createShareFolder).toHaveBeenCalledTimes(1)
  })
  it('明确路由不存在后允许继续，其他404保持未知且禁止重建', async () => {
    client.createShareFolder.mockRejectedValueOnce(new OrgApiHttpError(404, '接口不存在'))
    expect((await share()).completion).toBe('incomplete')
    expect(saved.folders.find((f: any) => f.itemId === 'z').phase).toBe('failure')
    saved.folders.find((f: any) => f.itemId === 'z').phase = 'unknown'
    expect((await share()).completion).toBe('completed')
    saved = undefined
    client.createShareFolder.mockRejectedValueOnce(new OrgApiHttpError(404, '目录不存在'))
    expect((await share()).completion).toBe('incomplete')
    const sent = client.createShareFolder.mock.calls.length
    expect((await share()).completion).toBe('incomplete')
    expect(client.createShareFolder).toHaveBeenCalledTimes(sent)
  })
  it('目录创建响应丢失后暂停且不能重建或上传', async () => {
    client.createShareFolder.mockRejectedValue(new Error('超时'))
    expect((await share()).completion).toBe('incomplete')
    expect((await share()).completion).toBe('incomplete')
    expect(client.createShareFolder).toHaveBeenCalledTimes(1)
    expect(client.uploadShareStream).not.toHaveBeenCalled()
  })
  it('已保存目录ID核对失败后保留ID，下次只核对不重建', async () => {
    client.verifyFolder.mockRejectedValueOnce(new Error('核对失败'))
    expect((await share()).completion).toBe('incomplete')
    expect(saved.folders.find((f: any) => f.itemId === 'z').folderId).toBe('remote-z')
    expect((await share()).completion).toBe('completed')
    expect(client.createShareFolder).toHaveBeenCalledTimes(3)
  })
  it('目录改名或文件移动后阻止继续分享', async () => {
    await share()
    const changed = async () => ({ files: [{ ...entry, parentItemId: 'z' }], folders })
    expect(
      (
        await new FirstShareUpload(store, client).run(
          'key',
          '库',
          changed,
          () => {},
          () => {}
        )
      ).completion
    ).toBe('incomplete')
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it('仅核对不得创建尚未发送的目录', async () => {
    client.createShareFolder.mockRejectedValueOnce(new OrgApiHttpError(422, '非法名称'))
    await share()
    await share(true)
    expect(client.createShareFolder).toHaveBeenCalledTimes(1)
    expect(client.uploadShareStream).not.toHaveBeenCalled()
  })
})
describe('首次上传写前日志', () => {
  it('创建响应丢失后禁止重建空间', async () => {
    client.createShareSpace.mockRejectedValue(new Error('断网'))
    await run()
    expect(saved.creation).toBe('unknown')
    await run()
    expect(client.createShareSpace).toHaveBeenCalledTimes(1)
  })
  it('创建和上传请求发出前intent已经持久化', async () => {
    client.createShareSpace.mockImplementation(async () => {
      expect(saved.creation).toBe('intent')
      return { share_id: 'space' }
    })
    client.uploadShareStream.mockImplementation(async () => {
      expect(saved.files[0].phase).toBe('intent')
      return { share_id: 'space', file_id: 'file', chunk_count: 1 }
    })
    expect((await run()).completion).toBe('completed')
    expect(saved.files[0]).toMatchObject({ fileId: 'file', phase: 'success' })
  })
  it('未知上传结果暂停余下文件，重复调用也不重传', async () => {
    client.uploadShareStream.mockRejectedValue(new Error('超时'))
    const upload = new FirstShareUpload(store, client)
    await upload.run(
      'key',
      '库',
      async () => [entry, { ...entry, itemId: 'j' }],
      () => {},
      () => {}
    )
    expect(saved.files.map((file: any) => file.phase)).toEqual(['unknown', 'pending'])
    await upload.run(
      'key',
      '库',
      async () => [entry, { ...entry, itemId: 'j' }],
      () => {},
      () => {}
    )
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it('已知fileId在核对前保存，核对失败后只核对不重复上传', async () => {
    client.verify.mockRejectedValueOnce(new Error('解析中'))
    await run()
    expect(saved.files[0]).toMatchObject({ phase: 'unknown', fileId: 'file' })
    expect((await run()).completion).toBe('completed')
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it.each([
    { share_id: 'other-space', file_id: 'wrong-file', chunk_count: 1 },
    { share_id: 'space', file_id: 'wrong-file', chunk_count: 2 }
  ])('无效上传响应不得持久化为可恢复认领的ID：%j', async (response) => {
    client.uploadShareStream.mockResolvedValueOnce(response)
    expect((await run()).completion).toBe('incomplete')
    expect(saved.files[0]).toMatchObject({ phase: 'unknown', fileId: null })
    expect((await run()).completion).toBe('incomplete')
    expect(client.verify).not.toHaveBeenCalled()
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it('已有success但本地指纹变化时不得返回completed', async () => {
    await run()
    const result = await new FirstShareUpload(store, client).run(
      'key',
      '库',
      async () => [{ ...entry, fingerprint: 'changed' }],
      () => {},
      () => {}
    )
    expect(result.completion).toBe('incomplete')
    expect(saved.files[0].phase).toBe('success')
  })
  it('verifyOnly对已有success核对失败时必须撤销成功，且不重传', async () => {
    await run()
    client.verify.mockRejectedValueOnce(new Error('远端归属已变化'))
    const result = await new FirstShareUpload(store, client).run(
      'key',
      '库',
      async () => [entry],
      () => {},
      () => {},
      true
    )
    expect(result.completion).toBe('incomplete')
    expect(saved.files[0]).toMatchObject({ phase: 'unknown', fileId: 'file' })
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it('持久化失败时绝不发出远端写请求', async () => {
    const upload = new FirstShareUpload(
      {
        get: () => undefined,
        set: () => {
          throw new Error('磁盘已满')
        }
      },
      client
    )
    await expect(
      upload.run(
        'key',
        '库',
        async () => [entry],
        () => {},
        () => {}
      )
    ).rejects.toThrow('磁盘已满')
    expect(client.createShareSpace).not.toHaveBeenCalled()
  })
  it('明确未写入后继续，只跳过核对成功的文件并补传余项', async () => {
    const upload = new FirstShareUpload(store, client)
    const plan = async () => [entry, { ...entry, itemId: 'j' }, { ...entry, itemId: 'k' }]
    client.uploadShareStream
      .mockResolvedValueOnce({ share_id: 'space', file_id: 'file', chunk_count: 1 })
      .mockRejectedValueOnce(new OrgApiHttpError(422, '格式校验失败'))
    await upload.run(
      'key',
      '库',
      plan,
      () => {},
      () => {}
    )
    expect(saved.files.map((file: any) => file.phase)).toEqual(['success', 'failure', 'pending'])
    expect(
      (
        await upload.run(
          'key',
          '库',
          plan,
          () => {},
          () => {}
        )
      ).completion
    ).toBe('completed')
    expect(client.uploadShareStream).toHaveBeenCalledTimes(4)
    expect(client.createShareSpace).toHaveBeenCalledTimes(1)
  })
  it('5xx后暂停且不能自动重传', async () => {
    client.uploadShareStream.mockRejectedValue(new OrgApiHttpError(500, '结果未知'))
    await run()
    expect(saved.files[0].phase).toBe('unknown')
    await run()
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
  })
  it.each([20 * 1024 * 1024 - 1, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1, 2 ** 31, 2 ** 31 + 1])(
    '首次上传不按客户端总容量拦截%s字节元数据计划',
    async (size) => {
      const report = vi.fn()
      const result = await new FirstShareUpload(store, client).run(
        'key',
        '库',
        async () => [{ ...entry, size }],
        report,
        () => {}
      )
      expect(result.completion).toBe('completed')
      expect(saved.files[0]).toMatchObject({ size, phase: 'success' })
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ totalBytes: size, uploadedBytes: size }))
    }
  )
  it('多个文件累计超过2GiB仍允许首次上传', async () => {
    const result = await new FirstShareUpload(store, client).run(
      'key',
      '库',
      async () => [entry, { ...entry, itemId: 'j', size: 2 ** 31 }],
      () => {},
      () => {}
    )
    expect(result.completion).toBe('completed')
    expect(saved.files.map((file: any) => file.phase)).toEqual(['success', 'success'])
  })
  it('服务端413仍暂停上传并保留明确失败结果', async () => {
    client.uploadShareStream.mockRejectedValue(new OrgApiHttpError(413, '服务端容量限制'))
    expect((await run()).completion).toBe('incomplete')
    expect(saved.files[0]).toMatchObject({ phase: 'failure', error: '服务端容量限制', fileId: null })
  })
})
describe('可选不上传源文件', () => {
  it('uploadOriginal=false透传给上传与核对客户端并持久模式', async () => {
    const upload = new FirstShareUpload(store, client)
    expect(
      (
        await upload.run(
          'key',
          '库',
          async () => [{ ...entry, uploadOriginal: false }],
          () => {},
          () => {}
        )
      ).completion
    ).toBe('completed')
    expect(client.uploadShareStream.mock.calls[0][1]).toMatchObject({ uploadOriginal: false })
    expect(saved.files[0]).toMatchObject({ uploadOriginal: false, phase: 'success', fileId: 'file' })
  })
  it('uploadOriginal=true显式透传并持久模式', async () => {
    await new FirstShareUpload(store, client).run(
      'key',
      '库',
      async () => [{ ...entry, uploadOriginal: true }],
      () => {},
      () => {}
    )
    expect(client.uploadShareStream.mock.calls[0][1]).toMatchObject({ uploadOriginal: true })
    expect(saved.files[0]).toMatchObject({ uploadOriginal: true })
  })
  it.each([
    [false, undefined],
    [false, true],
    [true, false],
    [undefined, false]
  ])('恢复时上传选项变化则暂停，禁止错模式恢复且不重传：%s → %s', async (previous, current) => {
    const upload = new FirstShareUpload(store, client)
    await upload.run(
      'key',
      '库',
      async () => [{ ...entry, uploadOriginal: previous }],
      () => {},
      () => {}
    )
    if (previous === undefined) delete saved.files[0].uploadOriginal
    expect(saved.files[0].phase).toBe('success')
    const before = structuredClone(saved)
    const report = vi.fn()
    const result = await upload.run(
      'key',
      '库',
      async () => [{ ...entry, uploadOriginal: current }],
      report,
      () => {}
    )
    expect(result.completion).toBe('incomplete')
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused', error: expect.any(String) }))
    expect(saved).toEqual(before)
    expect(client.createShareSpace).toHaveBeenCalledTimes(1)
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
    expect(client.verify).toHaveBeenCalledTimes(1)
  })
  it.each([
    [false, false],
    [true, true],
    [undefined, true],
    [true, undefined],
    [undefined, undefined]
  ])('恢复时上传选项一致可继续核对完成：%s → %s', async (previous, current) => {
    const upload = new FirstShareUpload(store, client)
    await upload.run(
      'key',
      '库',
      async () => [{ ...entry, uploadOriginal: previous }],
      () => {},
      () => {}
    )
    if (previous === undefined) delete saved.files[0].uploadOriginal
    const result = await upload.run(
      'key',
      '库',
      async () => [{ ...entry, uploadOriginal: current }],
      () => {},
      () => {}
    )
    expect(result.completion).toBe('completed')
    expect(client.uploadShareStream).toHaveBeenCalledTimes(1)
    expect(client.verify).toHaveBeenCalledTimes(2)
  })
})
