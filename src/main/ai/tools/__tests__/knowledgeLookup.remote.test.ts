import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

const mocks = vi.hoisted(() => ({
  localSearch: vi.fn(),
  localList: vi.fn(),
  localRoots: vi.fn(),
  resolveClientConfig: vi.fn(),
  listRemoteBases: vi.fn(),
  remoteSearch: vi.fn(),
  remoteRead: vi.fn(),
  clientConfigs: [] as unknown[]
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'KnowledgeService') {
        return {
          search: mocks.localSearch,
          listBasesForDiscovery: mocks.localList,
          listRootItems: mocks.localRoots
        }
      }
      if (name === 'RemoteKnowledgeService') {
        return {
          resolveClientConfig: mocks.resolveClientConfig,
          listRemoteBases: mocks.listRemoteBases
        }
      }
      throw new Error(`Unexpected application.get(${name})`)
    }
  }
}))

vi.mock('@main/features/remoteKnowledge/RemoteKnowledgeClient', () => ({
  RemoteKnowledgeClient: class {
    constructor(config: unknown) {
      mocks.clientConfigs.push(config)
    }
    search = mocks.remoteSearch
    read = mocks.remoteRead
  }
}))

import { listOrOutlineKnowledge, manageKnowledge, readOrGrepConcept, searchKnowledge } from '../knowledgeLookup'

const remoteId = 'remote:svc-1:base:docs'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.clientConfigs.length = 0
  mocks.resolveClientConfig.mockReturnValue({
    id: 'svc-1',
    baseUrl: 'https://kb.example.com',
    authType: 'bearer',
    apiKey: 'secret',
    timeoutMs: 30_000
  })
  mocks.localList.mockReturnValue({ items: [], total: 0 })
  mocks.localRoots.mockReturnValue([])
  mocks.listRemoteBases.mockResolvedValue([])
})

describe('knowledgeLookup remote routing', () => {
  it('searches a parsed remote base id and merges/deduplicates with local results', async () => {
    mocks.localSearch.mockResolvedValue([
      {
        pageContent: 'duplicate content',
        score: 0.4,
        conceptId: 'local-doc',
        title: 'Local duplicate',
        metadata: { itemType: 'file' }
      },
      {
        pageContent: 'local only',
        score: 0.7,
        conceptId: 'local-only',
        title: 'Local only',
        metadata: { itemType: 'note' }
      }
    ])
    mocks.remoteSearch.mockResolvedValue([
      {
        chunk_id: 'chunk-1',
        base_id: 'base:docs',
        document_id: 'remote-doc',
        title: 'Remote duplicate',
        content: 'duplicate content',
        score: 1.4,
        source: { url: 'https://example.com/doc' }
      }
    ])

    const result = await searchKnowledge('query', ['local-1', remoteId], [])

    expect(mocks.resolveClientConfig).toHaveBeenCalledWith('svc-1')
    expect(mocks.remoteSearch).toHaveBeenCalledWith({ query: 'query', base_ids: ['base:docs'], top_k: 8 })
    expect(result).toEqual([
      expect.objectContaining({
        baseId: remoteId,
        conceptId: 'remote-doc',
        title: 'Remote duplicate',
        content: 'duplicate content',
        score: 1
      }),
      expect.objectContaining({ baseId: 'local-1', content: 'local only', score: 0.7 })
    ])
  })

  it('keeps local results when the remote service fails, and reports an error when all targets fail', async () => {
    mocks.localSearch.mockResolvedValue([
      { pageContent: 'local survives', score: 0.8, conceptId: 'local-doc', title: 'Local', metadata: { itemType: 'file' } }
    ])
    mocks.resolveClientConfig.mockImplementation(() => {
      throw new Error('remote service disabled')
    })

    const partial = await searchKnowledge('query', ['local-1', remoteId], [])
    expect(partial).toEqual([expect.objectContaining({ baseId: 'local-1', content: 'local survives' })])

    mocks.localSearch.mockRejectedValueOnce(new Error('local failed'))
    const failed = await searchKnowledge('query', ['local-1', remoteId], [])
    expect(failed).toEqual({ error: 'local failed' })
  })

  it('lists remote bases on the first page and skips them when discovery fails', async () => {
    mocks.localList.mockReturnValue({
      items: [{ id: 'local-1', name: 'Local', groupId: null, status: 'completed' }],
      total: 1
    })
    mocks.listRemoteBases.mockResolvedValue([
      {
        id: remoteId,
        serviceId: 'svc-1',
        serviceName: 'Corp',
        remoteBaseId: 'base:docs',
        name: 'Remote docs'
      }
    ])

    const listed = await listOrOutlineKnowledge({ limit: 20 }, [])
    expect(listed).toEqual({
      items: [
        expect.objectContaining({ id: 'local-1', name: 'Local' }),
        {
          id: remoteId,
          name: 'Remote docs',
          groupId: null,
          status: 'completed',
          itemsUnavailable: true,
          sampleSources: []
        }
      ],
      total: 2
    })

    mocks.listRemoteBases.mockRejectedValueOnce(new Error('remote unavailable'))
    expect(await listOrOutlineKnowledge({ limit: 20 }, [])).toEqual({
      items: [expect.objectContaining({ id: 'local-1', name: 'Local' })],
      total: 1
    })
  })

  it('filters remote list results by scope and does not repeat them on cursor pages', async () => {
    mocks.listRemoteBases.mockResolvedValue([
      { id: remoteId, serviceId: 'svc-1', serviceName: 'Corp', remoteBaseId: 'base:docs', name: 'Allowed remote' },
      {
        id: 'remote:svc-2:private',
        serviceId: 'svc-2',
        serviceName: 'Private',
        remoteBaseId: 'private',
        name: 'Out of scope'
      }
    ])

    const scoped = await listOrOutlineKnowledge({ limit: 20 }, [remoteId])
    expect('items' in scoped ? scoped.items.map((item) => item.id) : []).toEqual([remoteId])
    expect(mocks.localList).not.toHaveBeenCalled()

    mocks.localList.mockReturnValue({ items: [], total: 0 })
    const continuation = await listOrOutlineKnowledge({ cursor: 'next', limit: 20 }, [])
    expect(continuation).toEqual({ items: [], total: 0 })
  })

  it('returns guidance for remote outline, grep, and manage modes', async () => {
    const outline = await listOrOutlineKnowledge({ baseId: remoteId, limit: 20 }, [remoteId])
    expect(outline).toEqual({ error: expect.stringMatching(/remote|远端|outline|大纲/i) })

    const grep = await readOrGrepConcept(
      { baseId: remoteId, conceptId: 'doc-1', pattern: 'needle' },
      [remoteId]
    )
    expect(grep).toEqual({ error: expect.stringMatching(/remote|远端|grep/i) })

    const managed = await manageKnowledge({ baseId: remoteId, action: 'refresh', conceptIds: ['doc-1'] }, [remoteId])
    expect(managed).toEqual({ error: expect.stringMatching(/read.?only|只读|remote|远端/i) })
    expect(mocks.remoteSearch).not.toHaveBeenCalled()
  })

  it('reads a remote document and maps it to KbReadOutput', async () => {
    mocks.remoteRead.mockResolvedValue({
      document_id: 'doc-1',
      title: 'Remote document',
      content: 'complete remote content',
      total_chars: 23,
      truncated: false
    })

    const result = await readOrGrepConcept({ baseId: remoteId, conceptId: 'doc-1' }, [remoteId])

    expect(mocks.remoteRead).toHaveBeenCalledWith({ base_id: 'base:docs', document_id: 'doc-1' })
    expect(result).toEqual(
      expect.objectContaining({
        baseId: remoteId,
        conceptId: 'doc-1',
        title: 'Remote document',
        type: 'file',
        totalChars: 23,
        charStart: 0,
        charEnd: 23,
        content: 'complete remote content',
        truncated: false
      })
    )
  })

  it('rejects an out-of-scope remote id before resolving the service', async () => {
    const result = await readOrGrepConcept({ baseId: remoteId, conceptId: 'doc-1' }, ['local-1'])
    expect(result).toEqual({ error: `Knowledge base "${remoteId}" is not available to this assistant.` })
    expect(mocks.resolveClientConfig).not.toHaveBeenCalled()
  })
})
