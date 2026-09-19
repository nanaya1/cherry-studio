import { describe, expect, it } from 'vitest'

import {
  buildRemoteKnowledgeBaseId,
  isRemoteKnowledgeBaseId,
  parseRemoteKnowledgeBaseId,
  RemoteAuthTypeSchema,
  RemoteKnowledgeServiceInfoSchema,
  RemoteReadRequestSchema,
  RemoteSearchRequestSchema,
  RemoteWireChunkSchema,
  RemoteWireErrorSchema
} from '../remoteKnowledge'

describe('buildRemoteKnowledgeBaseId', () => {
  it('joins prefix, serviceId and remoteBaseId literally', () => {
    expect(buildRemoteKnowledgeBaseId('svc1', 'kb-001')).toBe('remote:svc1:kb-001')
  })

  it('does not encode or filter remoteBaseId containing /, CJK or colon', () => {
    expect(buildRemoteKnowledgeBaseId('svc1', 'base/中文:x')).toBe('remote:svc1:base/中文:x')
  })
})

describe('parseRemoteKnowledgeBaseId', () => {
  it('parses a well-formed id', () => {
    expect(parseRemoteKnowledgeBaseId('remote:svc1:kb-001')).toEqual({
      serviceId: 'svc1',
      remoteBaseId: 'kb-001'
    })
  })

  it('splits only on the first colon inside remoteBaseId', () => {
    expect(parseRemoteKnowledgeBaseId('remote:svc1:a:b')).toEqual({
      serviceId: 'svc1',
      remoteBaseId: 'a:b'
    })
  })

  it('round-trips arbitrary inputs (serviceId carries no colon)', () => {
    const cases: Array<[string, string]> = [
      ['svc1', 'kb-001'],
      ['a', 'a/b'],
      ['中文', '文档'],
      ['s', 'x:y'],
      ['svc', 'a:b:c'],
      ['sp', 'with space'],
      ['deep', 'slash/nested/deep']
    ]
    for (const [serviceId, remoteBaseId] of cases) {
      const id = buildRemoteKnowledgeBaseId(serviceId, remoteBaseId)
      expect(parseRemoteKnowledgeBaseId(id)).toEqual({ serviceId, remoteBaseId })
    }
  })

  it('returns null for a local uuid id without the prefix', () => {
    expect(parseRemoteKnowledgeBaseId('local-uuid-xxx')).toBeNull()
  })

  it('returns null when remoteBaseId is missing', () => {
    expect(parseRemoteKnowledgeBaseId('remote:svc1')).toBeNull()
  })

  it('returns null when serviceId is empty', () => {
    expect(parseRemoteKnowledgeBaseId('remote::x')).toBeNull()
  })

  it('returns null when remoteBaseId is empty', () => {
    expect(parseRemoteKnowledgeBaseId('remote:s:')).toBeNull()
  })

  it('returns null when the prefix is not lowercase remote:', () => {
    expect(parseRemoteKnowledgeBaseId('REMOTE:s:x')).toBeNull()
  })
})

describe('isRemoteKnowledgeBaseId', () => {
  it('is true for parseable ids', () => {
    expect(isRemoteKnowledgeBaseId('remote:svc1:kb-001')).toBe(true)
    expect(isRemoteKnowledgeBaseId('remote:svc1:a:b')).toBe(true)
  })

  it('is false for the null cases', () => {
    expect(isRemoteKnowledgeBaseId('local-uuid-xxx')).toBe(false)
    expect(isRemoteKnowledgeBaseId('remote:svc1')).toBe(false)
    expect(isRemoteKnowledgeBaseId('remote::x')).toBe(false)
    expect(isRemoteKnowledgeBaseId('remote:s:')).toBe(false)
    expect(isRemoteKnowledgeBaseId('REMOTE:s:x')).toBe(false)
  })
})

describe('RemoteAuthTypeSchema', () => {
  it('accepts bearer, api_key and oauth2', () => {
    expect(RemoteAuthTypeSchema.safeParse('bearer').success).toBe(true)
    expect(RemoteAuthTypeSchema.safeParse('api_key').success).toBe(true)
    expect(RemoteAuthTypeSchema.safeParse('oauth2').success).toBe(true)
  })

  it('rejects basic', () => {
    expect(RemoteAuthTypeSchema.safeParse('basic').success).toBe(false)
  })
})

describe('RemoteKnowledgeServiceInfoSchema', () => {
  const valid = {
    id: 'svc1',
    name: 'My Service',
    baseUrl: 'https://kb.example.com',
    authType: 'bearer',
    headers: { Authorization: 'Bearer x' },
    timeoutMs: 30_000,
    enabled: true,
    hasApiKey: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  }

  it('accepts a fully valid object', () => {
    expect(RemoteKnowledgeServiceInfoSchema.safeParse(valid).success).toBe(true)
  })

  it('trims and requires non-empty name', () => {
    expect(RemoteKnowledgeServiceInfoSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false)
  })

  it('rejects an illegal baseUrl', () => {
    expect(RemoteKnowledgeServiceInfoSchema.safeParse({ ...valid, baseUrl: 'not-a-url' }).success).toBe(false)
  })

  it('rejects timeoutMs below the lower bound', () => {
    expect(RemoteKnowledgeServiceInfoSchema.safeParse({ ...valid, timeoutMs: 500 }).success).toBe(false)
  })

  it('rejects unknown keys (strictObject)', () => {
    expect(RemoteKnowledgeServiceInfoSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })
})

describe('RemoteWireChunkSchema', () => {
  const valid = {
    chunk_id: 'c1',
    base_id: 'b1',
    document_id: 'd1',
    title: 'Title',
    content: 'Content',
    score: 0.5,
    source: { url: 'https://example.com' },
    metadata: { k: 'v' }
  }

  it('accepts a valid wire chunk', () => {
    expect(RemoteWireChunkSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects score above 1', () => {
    expect(RemoteWireChunkSchema.safeParse({ ...valid, score: 1.5 }).success).toBe(false)
  })

  it('rejects score below 0', () => {
    expect(RemoteWireChunkSchema.safeParse({ ...valid, score: -0.1 }).success).toBe(false)
  })

  it('rejects an empty chunk_id', () => {
    expect(RemoteWireChunkSchema.safeParse({ ...valid, chunk_id: '' }).success).toBe(false)
  })

  it('tolerates unknown forward-compatible fields (inbound is lenient)', () => {
    expect(RemoteWireChunkSchema.safeParse({ ...valid, vendor_new_field: 1 }).success).toBe(true)
  })

  it('tolerates unknown fields inside source', () => {
    expect(RemoteWireChunkSchema.safeParse({ ...valid, source: { url: 'https://x', kind: 'web' } }).success).toBe(true)
  })
})

describe('RemoteSearchRequestSchema', () => {
  const valid = {
    query: 'hello',
    base_ids: ['b1', 'b2']
  }

  it('accepts a valid search request', () => {
    expect(RemoteSearchRequestSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects an empty query', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, query: '' }).success).toBe(false)
  })

  it('rejects a query over 1000 chars', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, query: 'x'.repeat(1001) }).success).toBe(false)
  })

  it('rejects an empty base_ids array', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, base_ids: [] }).success).toBe(false)
  })

  it('rejects 33 base_ids', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, base_ids: Array(33).fill('b') }).success).toBe(false)
  })

  it('rejects top_k of 0', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, top_k: 0 }).success).toBe(false)
  })

  it('rejects top_k of 51', () => {
    expect(RemoteSearchRequestSchema.safeParse({ ...valid, top_k: 51 }).success).toBe(false)
  })

  it('trims surrounding whitespace from query', () => {
    const parsed = RemoteSearchRequestSchema.parse({ ...valid, query: '  hi  ' })
    expect(parsed.query).toBe('hi')
  })
})

describe('RemoteReadRequestSchema', () => {
  const valid = { base_id: 'b1', document_id: 'd1', chunk_id: 'c1' }

  it('accepts a valid read request', () => {
    expect(RemoteReadRequestSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects an empty base_id', () => {
    expect(RemoteReadRequestSchema.safeParse({ ...valid, base_id: '' }).success).toBe(false)
  })
})

describe('RemoteWireErrorSchema', () => {
  it('accepts a valid wire error', () => {
    expect(RemoteWireErrorSchema.safeParse({ error: { code: 'E1', message: 'boom' } }).success).toBe(true)
  })

  it('rejects a missing error envelope', () => {
    expect(RemoteWireErrorSchema.safeParse({ code: 'E1' }).success).toBe(false)
  })

  it('rejects a non-string code', () => {
    expect(RemoteWireErrorSchema.safeParse({ error: { code: 1, message: 'boom' } }).success).toBe(false)
  })

  it('tolerates unknown forward-compatible fields (inbound is lenient)', () => {
    expect(RemoteWireErrorSchema.safeParse({ error: { code: 'E1', message: 'boom', retryable: true } }).success).toBe(
      true
    )
  })
})
