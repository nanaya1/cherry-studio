import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { encodeOrgId } from '@shared/data/types/enterpriseKnowledge'

import { listOrOutlineKnowledge, manageKnowledge, readOrGrepConcept, searchKnowledge } from '../knowledgeLookup'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  read: vi.fn(),
  listItems: vi.fn(),
  catalog: vi.fn(),
  localSearch: vi.fn(),
  localList: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(application.get).mockImplementation(((name: string) => {
    if (name === 'EnterprisePlugin') return { knowledge: mocks }
    if (name === 'KnowledgeService')
      return {
        search: mocks.localSearch,
        listBasesForDiscovery: mocks.localList,
        listRootItems: () => []
      }
    if (name === 'RemoteKnowledgeService') return { listRemoteBases: async () => [] }
    throw new Error(`Unexpected service: ${name}`)
  }) as typeof application.get)
  mocks.localList.mockReturnValue({ items: [], total: 0 })
  mocks.catalog.mockResolvedValue({ public: [], shared: [], owned: [] })
})

const baseId = encodeOrgId('space:one')
const documentId = encodeOrgId('doc:one')
const base = (id = baseId, name = '组织资料') => ({ id, name, description: null, documentCount: 3 })

describe('组织知识库检索契约', () => {
  it('保留编码后的来源和引用，并与本地结果按内容去重', async () => {
    mocks.search.mockResolvedValue({
      chunks: [
        { baseId, documentId, chunkId: encodeOrgId('chunk'), title: '组织正文', content: '重复正文', score: 1.2 }
      ]
    })
    mocks.localSearch.mockResolvedValue([{ pageContent: '重复正文', score: 0.4, title: '本地正文' }])
    const result = await searchKnowledge('问题', [baseId, 'local'], [])
    expect(result).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        baseId,
        conceptId: documentId,
        title: '组织正文',
        content: '重复正文',
        score: 1
      })
    ])
    expect(mocks.search).toHaveBeenCalledWith({ baseIds: [baseId], query: '问题', topK: 8 })
    expect(mocks.localSearch).toHaveBeenCalledWith('local', '问题')
  })

  it('读取组织正文并保留完整文档元信息', async () => {
    mocks.read.mockResolvedValue({ documentId, title: '组织文档', content: 'abcdef', totalChars: 6, truncated: false })
    expect(await readOrGrepConcept({ baseId, conceptId: documentId }, [])).toEqual(
      expect.objectContaining({
        baseId,
        conceptId: documentId,
        content: 'abcdef',
        charStart: 0,
        charEnd: 6,
        totalChars: 6,
        truncated: false
      })
    )
    expect(mocks.read).toHaveBeenCalledWith({ baseId, documentId })
  })

  it.each([
    { charStart: 2, charEnd: 5, content: 'cde', start: 2, end: 5 },
    { charStart: 4, charEnd: 99, content: 'ef', start: 4, end: 6 },
    { charStart: 99, content: '', start: 6, end: 6 },
    { charStart: 4, charEnd: 2, content: '', start: 4, end: 4 }
  ])('按工具字符范围读取组织正文：$charStart 到 $charEnd', async ({ charStart, charEnd, content, start, end }) => {
    mocks.read.mockResolvedValue({ documentId, title: '组织文档', content: 'abcdef', totalChars: 6, truncated: false })
    expect(await readOrGrepConcept({ baseId, conceptId: documentId, charStart, charEnd }, [])).toEqual(
      expect.objectContaining({ content, charStart: start, charEnd: end, totalChars: 6, truncated: false })
    )
    expect(mocks.read).toHaveBeenCalledWith({ baseId, documentId })
  })

  it('组织正文每页最多 20000 字符且续读不重复', async () => {
    mocks.read.mockResolvedValue({ documentId, title: '长文档', content: 'a'.repeat(20000) + '尾页', truncated: false })
    expect(await readOrGrepConcept({ baseId, conceptId: documentId }, [])).toEqual(
      expect.objectContaining({
        content: 'a'.repeat(20000),
        charStart: 0,
        charEnd: 20000,
        totalChars: 20002,
        truncated: true
      })
    )
    expect(await readOrGrepConcept({ baseId, conceptId: documentId, charStart: 20000 }, [])).toEqual(
      expect.objectContaining({
        content: '尾页',
        charStart: 20000,
        charEnd: 20002,
        totalChars: 20002,
        truncated: false
      })
    )
  })

  it.each([
    { truncated: true, totalChars: 6 },
    { truncated: false, totalChars: 100 }
  ])('上游正文不完整时明确提示不可继续分页：%j', async (metadata) => {
    mocks.read.mockResolvedValue({ documentId, title: '截断文档', content: 'abcdef', ...metadata })
    for (const charStart of [0, 6]) {
      expect(await readOrGrepConcept({ baseId, conceptId: documentId, charStart }, [])).toEqual({
        error: expect.stringMatching(/cannot continue.*pagin/i)
      })
    }
  })

  it('目录仅合并公共和分享给我的库，去重且遵守 scope、过滤和游标', async () => {
    const shared = base(encodeOrgId('shared'), '分享资料')
    mocks.catalog.mockResolvedValue({ public: [base()], shared: [base(), shared], owned: [base(encodeOrgId('owned'))] })
    expect(await listOrOutlineKnowledge({ limit: 20 }, [baseId, shared.id])).toEqual({
      items: [expect.objectContaining({ id: baseId, itemCount: 3 }), expect.objectContaining({ id: shared.id })],
      total: 2
    })
    expect(mocks.localList).not.toHaveBeenCalled()
    expect(await listOrOutlineKnowledge({ limit: 20, query: '分享' }, [])).toEqual({
      items: [expect.objectContaining({ id: shared.id })],
      total: 1
    })
    expect(await listOrOutlineKnowledge({ limit: 20, cursor: 'next' }, [baseId])).toEqual({ items: [], total: 0 })
    expect(await listOrOutlineKnowledge({ limit: 20, groupId: 'local-group' }, [baseId])).toEqual({
      items: [],
      total: 0
    })
  })

  it('列出组织知识库文件名并暴露可读取文档 ID', async () => {
    mocks.listItems.mockResolvedValue({
      items: [
        {
          id: encodeOrgId('item:one'),
          baseId,
          type: 'file',
          title: '虚拟现实数字化工厂.pdf',
          status: 'completed',
          documentId,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z'
        },
        {
          id: encodeOrgId('item:two'),
          baseId,
          type: 'file',
          title: '处理中.docx',
          status: 'processing',
          documentId: null,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z'
        }
      ],
      total: 3,
      nextCursor: 'next'
    })

    expect(await listOrOutlineKnowledge({ limit: 20, baseId }, [baseId])).toEqual({
      baseId,
      totalItems: 3,
      truncated: true,
      nodes: [
        {
          depth: 0,
          title: '虚拟现实数字化工厂.pdf',
          type: 'file',
          status: 'completed',
          conceptId: documentId
        },
        { depth: 0, title: '处理中.docx', type: 'file', status: 'processing' }
      ]
    })
    expect(mocks.listItems).toHaveBeenCalledWith(baseId)
  })

  it('拒绝组织库的写入、grep以及越权读取', async () => {
    expect(await readOrGrepConcept({ baseId, conceptId: documentId, pattern: 'x' }, [])).toEqual({
      error: expect.stringMatching(/grep/i)
    })
    for (const action of ['add', 'delete', 'refresh'] as const) {
      expect(await manageKnowledge({ baseId, action }, [])).toEqual({ error: expect.stringMatching(/read.only/i) })
    }
    expect(await readOrGrepConcept({ baseId, conceptId: documentId }, ['local'])).toEqual({
      error: expect.stringContaining('not available')
    })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('组织服务失败时保留本地结果，全部失败时报告错误', async () => {
    mocks.search.mockRejectedValue(new Error('组织账号不可用'))
    mocks.localSearch.mockResolvedValue([{ pageContent: '本地可用', score: 0.5, title: '本地' }])
    expect(await searchKnowledge('问题', [baseId, 'local'], [])).toEqual([
      expect.objectContaining({ content: '本地可用' })
    ])
    expect(await searchKnowledge('问题', [baseId], [])).toEqual({ error: '组织账号不可用' })
    mocks.catalog.mockRejectedValue(new Error('离线'))
    expect(await listOrOutlineKnowledge({ limit: 20 }, [])).toEqual({ items: [], total: 0 })
  })
})
