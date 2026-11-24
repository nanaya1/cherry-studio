import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dialog } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { JavaKnowledgeClient } from '../JavaKnowledgeClient'
import { uploadKnowledgeSource } from '../KnowledgeContentCommands'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('@main/i18n', async () => {
  const { default: messages } = await import('../../i18n/locales/zh-cn.json')
  return { t: (key: string) => messages[key as keyof typeof messages] }
})
const id = '11111111-1111-4111-8111-111111111111'
const folderId = 'a'.repeat(32),
  fileId = 'b'.repeat(32)
let root: string
const client = {
  getSpace: vi.fn(),
  createFolder: vi.fn(),
  uploadMultipart: vi.fn()
}
const java = client as unknown as JavaKnowledgeClient
beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'knowledge-content-'))
  client.getSpace.mockResolvedValue({ id, editable: true })
  client.createFolder.mockImplementation(async (_id, name, parentId) => ({
    knowledgeId: id,
    fileId: folderId,
    parentId: parentId ?? null,
    directory: true,
    name
  }))
  client.uploadMultipart.mockResolvedValue({ knowledgeId: id, fileId })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// 捕获公共库误走个人库importChunks，以及文件夹层级丢失的回归。
it('空间管理员文件夹逐文件上传原件，保留父目录，不发送预计算分块', async () => {
  const dir = join(root, '资料')
  await mkdir(dir)
  await writeFile(join(dir, '说明.txt'), '正文')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [dir] })
  client.uploadMultipart.mockImplementation(async (path, _contentType, length, body, guard) => {
    guard()
    const buffers: Buffer[] = []
    for await (const chunk of body(() => {}, new AbortController().signal)) buffers.push(Buffer.from(chunk))
    const payload = Buffer.concat(buffers)
    expect(path).toBe('/api/v1/client/knowledge/file/upload')
    expect(payload.length).toBe(length)
    expect(payload.toString()).toContain(`name="parentId"\r\n\r\n${folderId}`)
    expect(payload.toString()).toContain('正文')
    expect(payload.toString()).not.toContain('chunksFile')
    return { knowledgeId: id, fileId }
  })
  await expect(uploadKnowledgeSource(java, id, undefined, 'directory', () => {})).resolves.toBe(true)
  expect(client.uploadMultipart).toHaveBeenCalledTimes(1)
})

it('选取期间撤权会阻止写入，缺省editable不能靠所有者分类获得维护权', async () => {
  await writeFile(join(root, 'a.txt'), 'a')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [join(root, 'a.txt')] })
  client.getSpace.mockResolvedValueOnce({ id, editable: true }).mockResolvedValue({ id, category: 'OWNED' })
  await expect(uploadKnowledgeSource(java, id, undefined, 'file', () => {})).rejects.toMatchObject({ code: 10007 })
  expect(client.uploadMultipart).not.toHaveBeenCalled()
})

it('切换账号后旧文件选择不能继续上传', async () => {
  const active = vi.fn()
  vi.mocked(dialog.showOpenDialog).mockImplementation(async () => {
    active.mockImplementation(() => {
      throw new Error('stale')
    })
    return { canceled: false, filePaths: [join(root, 'a.txt')] }
  })
  await expect(uploadKnowledgeSource(java, id, undefined, 'file', active)).rejects.toThrow('stale')
  expect(client.uploadMultipart).not.toHaveBeenCalled()
})

it('首个上传结果未知即停止批次，不上传后续文件或自动重发', async () => {
  const files = ['a.txt', 'b.txt'].map((name) => join(root, name))
  for (const path of files) await writeFile(path, 'text')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: files })
  client.uploadMultipart.mockRejectedValue(new Error('unknown'))
  await expect(uploadKnowledgeSource(java, id, undefined, 'file', () => {})).rejects.toThrow('unknown')
  expect(client.uploadMultipart).toHaveBeenCalledTimes(1)
})

it('取消选择不报告已上传，也不发起写入', async () => {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
  await expect(uploadKnowledgeSource(java, id, undefined, 'file', () => {})).resolves.toBe(false)
  expect(client.uploadMultipart).not.toHaveBeenCalled()
})
