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
const client = { createShareSpace: vi.fn(), uploadShareStream: vi.fn(), verify: vi.fn() }
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
