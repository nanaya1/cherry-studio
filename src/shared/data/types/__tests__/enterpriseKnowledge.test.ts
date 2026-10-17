import { describe, expect, it } from 'vitest'

import { enterpriseKnowledgeRequestSchemas } from '../../../ipc/schemas/enterpriseKnowledge'
import {
  OrgKnowledgeCatalogSchema,
  OrgKnowledgeUploadProgressSchema,
  OrgKnowledgeItemPageSchema,
  OrgKnowledgeShareFileResultSchema,
  encodeOrgId,
  isOrgId,
  parseOrgId
} from '../enterpriseKnowledge'

it.each(['cleanup_pending', 'cleanup_unknown'])('首传清理状态%s可跨IPC保留，不能误判completed', (phase) => {
  expect(
    OrgKnowledgeUploadProgressSchema.parse({
      phase,
      totalBytes: 0,
      uploadedBytes: 0,
      completedFiles: 0,
      totalFiles: 1,
      currentFile: null,
      error: null
    }).phase
  ).toBe(phase)
})

it('catalog 分享证据与本机完成态独立，未知允许缺省', () => {
  const base = {
    id: encodeOrgId('s'),
    name: '副本',
    description: null,
    updatedAt: '2026-10-17T00:00:00Z',
    hasShareEvidence: true,
    shareCompleted: false
  }
  expect(OrgKnowledgeCatalogSchema.parse({ public: [], shared: [], owned: [base] }).owned[0]).toEqual(base)
  expect(
    OrgKnowledgeCatalogSchema.safeParse({ public: [], shared: [], owned: [{ ...base, hasShareEvidence: 'true' }] })
      .success
  ).toBe(false)
})

it('删除无本机副本允许空结果与续作 ID，输入不允许指定清理副本范围', () => {
  const routes = enterpriseKnowledgeRequestSchemas
  expect(routes['enterprise.knowledge.unshare'].output.parse({ ok: true, localBaseId: '' })).toEqual({
    ok: true,
    localBaseId: ''
  })
  expect(
    routes['enterprise.knowledge.cleanup_local'].input.parse({ baseId: encodeOrgId('s'), localBaseId: '' })
  ).toEqual({ baseId: encodeOrgId('s'), localBaseId: '' })
  expect(
    routes['enterprise.knowledge.unshare'].input.safeParse({
      baseId: encodeOrgId('s'),
      deleteLocal: true,
      localCopies: ['unrelated']
    }).success
  ).toBe(false)
})

describe('手动同步 IPC 契约', () => {
  it('仅接受本地 baseId 与本次确认，不接受远端目标或缺省确认', () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.sync_apply'].input
    const input = { baseId: 'local', planId: 'token', confirmDeletes: false }
    expect(schema.parse(input)).toEqual(input)
    expect(schema.safeParse({ baseId: 'local', planId: 'token' }).success).toBe(false)
    expect(schema.safeParse({ ...input, shareId: 'remote' }).success).toBe(false)
    expect(schema.safeParse({ ...input, baseId: encodeOrgId('remote') }).success).toBe(false)
    expect(
      enterpriseKnowledgeRequestSchemas['enterprise.knowledge.sync_status'].output.safeParse({
        state: 'unknown',
        lastSyncedAt: null
      }).success
    ).toBe(true)
  })
})

describe('orgkb id 编解码', () => {
  it('round-trips opaque ids including colons and unicode', () => {
    for (const raw of ['abc', 'space:123', 'b:with:many:colons', '用户-空间_42', 'a/b?x=1']) {
      const encoded = encodeOrgId(raw)
      expect(encoded.startsWith('orgkb:')).toBe(true)
      expect(parseOrgId(encoded)).toBe(raw)
    }
  })

  it('isOrgId only matches the orgkb: prefix', () => {
    expect(isOrgId(encodeOrgId('x'))).toBe(true)
    expect(isOrgId('remote:abc')).toBe(false)
    expect(isOrgId('orgkb')).toBe(false)
    expect(isOrgId('')).toBe(false)
  })

  it('parseOrgId rejects non-prefixed and malformed ids', () => {
    expect(parseOrgId('remote:abc')).toBeNull()
    expect(parseOrgId('orgkb:!!notbase64!!')).toBeNull()
    expect(parseOrgId('orgkb:')).toBeNull()
  })

  it('encodeOrgId throws on empty raw id', () => {
    expect(() => encodeOrgId('')).toThrow()
  })
})

describe('源文件开关 IPC 契约', () => {
  it('首传缺省上传原件，显式false保留，非布尔值拒绝且核对入口不接受模式覆盖', () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.share'].input
    expect(schema.parse({ baseId: 'local' })).toEqual({ baseId: 'local', uploadOriginal: true })
    expect(schema.parse({ baseId: 'local', uploadOriginal: false })).toEqual({ baseId: 'local', uploadOriginal: false })
    expect(schema.safeParse({ baseId: 'local', uploadOriginal: 'false' }).success).toBe(false)
    expect(
      enterpriseKnowledgeRequestSchemas['enterprise.knowledge.upload_verify'].input.safeParse({
        baseId: 'local',
        uploadOriginal: false
      }).success
    ).toBe(false)
  })
})

describe('重命名已分享本地知识库 IPC 契约', () => {
  it('接受本地 baseId 与 1-128 字符名称，拒绝 orgkb 远端 id 或越界名称', () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.rename_shared'].input
    expect(schema.safeParse({ baseId: 'local-uuid', name: '新名' }).success).toBe(true)
    expect(schema.safeParse({ baseId: encodeOrgId('s'), name: '新名' }).success).toBe(false)
    expect(schema.safeParse({ baseId: 'local-uuid', name: '   ' }).success).toBe(false)
    expect(schema.safeParse({ baseId: 'local-uuid', name: 'x'.repeat(129) }).success).toBe(false)
    expect(schema.safeParse({ baseId: 'local-uuid', name: 'x'.repeat(128) }).success).toBe(true)
  })
})

describe('分享码 IPC 契约', () => {
  it('创建有效期必传，支持永久并拒绝越界或额外权限', () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.create_share'].input
    const input = { baseId: encodeOrgId('s'), expireDays: 7 }
    expect(schema.parse({ ...input, expireDays: null })).toEqual({ ...input, expireDays: null })
    for (const patch of [
      { expireDays: undefined },
      { expireDays: 0 },
      { expireDays: 366 },
      { expireDays: 1.5 },
      { password: 'abc' },
      { password: 'x'.repeat(33) },
      { maxViews: 0 },
      { maxViews: Number.MAX_SAFE_INTEGER + 1 },
      { shareType: 3 },
      { baseId: 'raw' }
    ]) {
      expect(schema.safeParse({ ...input, ...patch }).success).toBe(false)
    }
  })
  it('领取保留分享码大小写，禁止链接、空白和非法提取码', () => {
    const schema = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.receive_share'].input
    expect(schema.parse({ shareCode: 'AbCd_123', password: 'pass' }).shareCode).toBe('AbCd_123')
    for (const shareCode of ['short', ' abcdefgh', 'abcdefgh/', 'x'.repeat(33)])
      expect(schema.safeParse({ shareCode }).success).toBe(false)
    expect(schema.safeParse({ shareCode: 'AbCd_123', password: '' }).success).toBe(false)
  })
})

describe('IPC 契约 schema', () => {
  it('邀请接受本地或云端 baseId 且有效期最多30天', () => {
    const invite = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.invite'].input
    expect(invite.safeParse({ baseId: 'local-uuid', userId: 1, expireDays: 30 }).success).toBe(true)
    expect(invite.safeParse({ baseId: encodeOrgId('b'), userId: 1, expireDays: 30 }).success).toBe(true)
    expect(invite.safeParse({ baseId: 'local-uuid', userId: 1, expireDays: 31 }).success).toBe(false)
    const search = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.search'].input
    expect(search.safeParse({ baseIds: [encodeOrgId('b')], query: 'q', topK: 51 }).success).toBe(false)
    expect(search.safeParse({ baseIds: [encodeOrgId('b')], query: '  ' }).success).toBe(false)
  })

  it('collaborators 输入仅 keyword/page/pageSize 且 pageSize 不超过50', () => {
    const collaborators = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.collaborators'].input
    expect(collaborators.safeParse({ keyword: 'a', page: 1, pageSize: 20 }).success).toBe(true)
    expect(collaborators.safeParse({}).success).toBe(true)
    expect(collaborators.safeParse({ pageSize: 51 }).success).toBe(false)
    expect(collaborators.safeParse({ keyword: 'x'.repeat(65) }).success).toBe(false)
    const out = enterpriseKnowledgeRequestSchemas['enterprise.knowledge.collaborators'].output
    expect(out.safeParse({ items: [{ id: 1, username: 'u' }], total: 9, page: 1, pageSize: 20 }).success).toBe(true)
    expect(out.safeParse({ items: [{ id: 1 }], total: 9, page: 1, pageSize: 20 }).success).toBe(false)
  })
  it('目录允许未知计数但不伪造为零', () => {
    expect(
      OrgKnowledgeCatalogSchema.safeParse({
        public: [{ id: encodeOrgId('s'), name: '空间', description: null }],
        shared: [],
        owned: []
      }).success
    ).toBe(true)
  })

  it('catalog requires three arrays', () => {
    const ok = OrgKnowledgeCatalogSchema.safeParse({
      public: [],
      shared: [],
      owned: [{ id: encodeOrgId('s1'), name: 'n', description: null, documentCount: 0 }]
    })
    expect(ok.success).toBe(true)
    expect(OrgKnowledgeCatalogSchema.safeParse({ public: [] }).success).toBe(false)
  })

  it('item page maps server field names through service, schema only checks IPC shape', () => {
    const ok = OrgKnowledgeItemPageSchema.safeParse({
      items: [
        {
          id: 'i',
          baseId: 'b',
          type: 'file',
          title: 't',
          status: 'completed',
          parentId: null,
          documentId: null,
          createdAt: 'c',
          updatedAt: 'u'
        }
      ],
      total: 1,
      nextCursor: null
    })
    expect(ok.success).toBe(true)
  })

  it('share file status enum is closed', () => {
    expect(
      OrgKnowledgeShareFileResultSchema.safeParse({
        fileName: 'f',
        status: 'success',
        fileId: 'x',
        chunkCount: 1,
        error: null
      }).success
    ).toBe(true)
    expect(
      OrgKnowledgeShareFileResultSchema.safeParse({
        fileName: 'f',
        status: 'weird',
        fileId: null,
        chunkCount: null,
        error: 'e'
      }).success
    ).toBe(false)
  })
})
