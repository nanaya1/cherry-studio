/**
 * [enterprise] OrgApiClient 会话刷新链路测试
 * 修复目标：token 过期后请求自动走 getValidSession 刷新；401 兜底重试一次；
 * 未登录仍然快速失败。
 * [enterprise] 分组目录改造后：列表接口必须携带登录会话，由服务端按 token 对应用户的 group_id 过滤。
 * 401 重试逻辑同时覆盖目录读取与写接口（request 链路）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
const { shareWarn } = vi.hoisted(() => ({ shareWarn: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

// OrgApiClient 只依赖 @logger，stub 掉避免拉起完整 logger 链
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: shareWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { OrgApiClient } from '@main/enterprise/OrgApiClient'
import { OrgKnowledgePreviewSchema } from '@shared/data/types/enterpriseKnowledge'

const session = (over: Partial<{ accessToken: string }> = {}) => ({
  userId: 'u1',
  phone: '13800000000',
  role: 'admin',
  accessToken: over.accessToken ?? 'stale-token',
  refreshToken: 'rt',
  expiresAt: Date.now() - 1000
})

describe('OrgApiClient server contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it.each(['bearer', 'cookie'])('技能二进制下载复用 %s 鉴权且禁止重定向', async (mode) => {
    const cookieFetch = vi.fn().mockResolvedValue(new Response('archive'))
    fetchMock.mockResolvedValue(new Response('archive'))
    const client = new OrgApiClient(
      vi.fn().mockResolvedValue({
        ...session(),
        accessToken: mode === 'cookie' ? '' : 'download-token',
        authMode: mode === 'cookie' ? 'management-cookie' : 'management-oauth'
      }),
      cookieFetch
    )
    const response = await client.downloadSkillPackage('/api/library-items/1/download?format=binary')
    expect(await response.text()).toBe('archive')
    const transport = mode === 'cookie' ? cookieFetch : fetchMock
    expect(transport).toHaveBeenCalledWith(
      expect.stringContaining('/api/library-items/1/download?format=binary'),
      expect.objectContaining({ redirect: 'error' })
    )
    const init = transport.mock.calls[0][1]
    if (mode === 'cookie') {
      expect(init.credentials).toBe('include')
      expect(init.headers.authorization).toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    } else {
      expect(init.headers.authorization).toBe('Bearer download-token')
      expect(cookieFetch).not.toHaveBeenCalled()
    }
  })

  it('技能下载拒绝外部 URL 和非技能路径且不发送凭据', async () => {
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session()))
    for (const path of [
      'https://evil.example/api/library-items/1/download',
      '//evil.example/api/library-items/1/download',
      '/api/users'
    ]) {
      await expect(client.downloadSkillPackage(path)).rejects.toThrow('技能包下载地址无效')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['bearer', 'cookie', 'refresh'])('分享失败原文透传且 %s 日志不含码或提取码', async (mode) => {
    shareWarn.mockClear()
    const errorResponse = () => new Response(JSON.stringify({ detail: '提取码不正确' }), { status: 403 })
    fetchMock.mockResolvedValueOnce(mode === 'refresh' ? new Response('', { status: 401 }) : errorResponse())
    if (mode === 'refresh') fetchMock.mockResolvedValueOnce(errorResponse())
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ ...session(), authMode: mode === 'cookie' ? 'management-cookie' : undefined })
      .mockResolvedValue(session({ accessToken: 'fresh' }))
    const client = new OrgApiClient(
      getSession,
      vi.fn().mockImplementation(async () => errorResponse())
    )
    await expect(
      client['request']('/api/kb/v1/shares/SecretCode123/receive', {
        method: 'POST',
        body: '{"password":"private-pass"}'
      })
    ).rejects.toMatchObject({ status: 403, message: '提取码不正确' })
    expect(JSON.stringify(shareWarn.mock.calls)).not.toMatch(/SecretCode123|private-pass/)
  })

  it.each(['bearer', 'cookie', 'refresh'])('本地副本上传 400 在 %s 传输中保留代理错误详情', async (mode) => {
    shareWarn.mockClear()
    const errorResponse = () => new Response(JSON.stringify({ error: '文件解析结果格式无效' }), { status: 400 })
    fetchMock.mockResolvedValueOnce(mode === 'refresh' ? new Response('', { status: 401 }) : errorResponse())
    if (mode === 'refresh') fetchMock.mockResolvedValueOnce(errorResponse())
    const client = new OrgApiClient(
      vi
        .fn()
        .mockResolvedValueOnce({ ...session(), authMode: mode === 'cookie' ? 'management-cookie' : undefined })
        .mockResolvedValue(session({ accessToken: 'fresh' })),
      vi.fn().mockImplementation(async () => errorResponse())
    )
    const form = new FormData()
    form.append('file', new Blob(['正文']), 'dqamst.pdf')
    form.append('chunks', '[]')
    await expect(client.requestMultipart('/api/kb/v1/local-share/spaces/copy/files', form)).rejects.toMatchObject({
      status: 400,
      message: '文件解析结果格式无效'
    })
    expect(shareWarn).not.toHaveBeenCalled()
  })

  it.each(['bearer', 'cookie', 'refresh'])('云端空间改名失败透传服务端详情且 %s 不记录响应体', async (mode) => {
    shareWarn.mockClear()
    const errorResponse = () => new Response(JSON.stringify({ detail: '空间名称已存在' }), { status: 422 })
    fetchMock.mockResolvedValueOnce(mode === 'refresh' ? new Response('', { status: 401 }) : errorResponse())
    if (mode === 'refresh') fetchMock.mockResolvedValueOnce(errorResponse())
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ ...session(), authMode: mode === 'cookie' ? 'management-cookie' : undefined })
      .mockResolvedValue(session({ accessToken: 'fresh' }))
    const client = new OrgApiClient(
      getSession,
      vi.fn().mockImplementation(async () => errorResponse())
    )

    await expect(
      client['request']('/api/v1/spaces/space', {
        method: 'PUT',
        body: JSON.stringify({ name: '新名' })
      })
    ).rejects.toMatchObject({ status: 422, message: '空间名称已存在' })
    expect(JSON.stringify(shareWarn.mock.calls)).not.toMatch(/新名/)
  })

  it('multipart 首次与401刷新均带 Bearer 且让 fetch 生成 boundary', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('{}'))
    const client = new OrgApiClient(
      vi
        .fn()
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(session({ accessToken: 'fresh' }))
    )
    const form = new FormData()
    form.append('file', new Blob(['正文']), 'a.txt')
    await client.requestMultipart('/api/kb/v1/local-share/spaces/s/files', form)
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get('authorization'))).toEqual([
      'Bearer stale-token',
      'Bearer fresh'
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).has('content-type')).toBe(false)
      expect(init.body).toBe(form)
    }
  })

  it.each(['json', 'multipart', 'text', 'bytes'] as const)(
    '管理员 %s 请求统一强制 client scope 并保留查询',
    async (kind) => {
      fetchMock.mockResolvedValue(new Response('{}'))
      const client = new OrgApiClient(vi.fn().mockResolvedValue(session()))
      const path = '/api/kb/v1/files/f/preview?scope=admin&scope=all&cursor=a%3Ab'
      if (kind === 'json') await client['request'](path)
      if (kind === 'multipart') await client.requestMultipart(path, new FormData())
      if (kind === 'text') await client.requestText(path)
      if (kind === 'bytes') await client.requestBytes(path)
      const url = new URL(fetchMock.mock.calls[0][0])
      expect(url.searchParams.getAll('scope')).toEqual(['client'])
      expect(url.searchParams.get('cursor')).toBe('a:b')
    }
  )

  it.each([true, false])('完整读取超过旧10MiB阈值的预览（声明长度：%s）', async (declared) => {
    const content = new Uint8Array(10 * 1024 * 1024 + 1).fill(65)
    fetchMock.mockResolvedValue(
      new Response(content, { headers: declared ? { 'content-length': String(content.length) } : {} })
    )
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session()))
    const bytes = await client.requestBytes('/api/kb/v1/files/f/preview')
    expect(bytes.length).toBe(content.length)
    expect(bytes.at(-1)).toBe(65)
  })

  it('IPC预览契约接受超过旧14MiB阈值的完整原文', () => {
    const result = OrgKnowledgePreviewSchema.safeParse({
      kind: 'inline',
      fileName: 'large.pdf',
      mimeType: 'application/pdf',
      content: '',
      base64: 'A'.repeat(14 * 1024 * 1024 + 4)
    })
    expect(result.success).toBe(true)
  })

  it('鉴权读取预览字节且禁止重定向', async () => {
    fetchMock.mockResolvedValue(new Response('原文'))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session()))
    expect((await client.requestBytes('/api/kb/v1/files/f/preview')).toString('utf8')).toBe('原文')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer stale-token' }
    })
  })

  it('uses the isolated Cookie transport without a Bearer header', async () => {
    const cookieFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ server_instance_id: 'server', user: { id: 7 } })))
    const client = new OrgApiClient(
      vi.fn().mockResolvedValue({ ...session(), authMode: 'management-cookie', accessToken: '' }),
      cookieFetch
    )
    await expect(client.getCurrentUser()).resolves.toMatchObject({ user: { id: 7 } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cookieFetch.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' })
    expect(cookieFetch.mock.calls[0][1].headers).not.toHaveProperty('authorization')
  })

  it('loads server identity and user from currentuser without requesting server-identity', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          server_instance_id: 'management-instance-1',
          user: { id: 'u1', group_id: 'g1', role: 'member', status: 'active' }
        }),
        { status: 200 }
      )
    )
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'fresh-token' })))

    await expect(client.getCurrentUser()).resolves.toMatchObject({
      server_instance_id: 'management-instance-1',
      user: { id: 'u1' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/api/currentuser')
    expect(fetchMock.mock.calls[0][0]).not.toContain('/api/server-identity')
  })

  it.each(['management-oauth', 'management-cookie'])(
    'revokes a captured %s session after local logout without refreshing',
    async (authMode) => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
      const cookieFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      const client = new OrgApiClient(async () => null, cookieFetch)
      await expect(client.revoke('refresh', { ...session(), authMode } as never)).resolves.toBeUndefined()
      const transport = authMode === 'management-cookie' ? cookieFetch : fetchMock
      expect(transport.mock.calls[0][0]).toContain('/api/auth/logout')
      expect(transport.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
      if (authMode === 'management-oauth')
        expect(transport.mock.calls[0][1].headers.authorization).toBe('Bearer stale-token')
      else expect(transport.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  )

  it('logs out through the modern server endpoint with the refresh token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'fresh-token' })))

    await expect(client.revoke('refresh-token-1')).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/auth/logout')
    expect(url).not.toContain('/api/auth/revoke')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'refresh-token-1' })
    })
  })
})

describe('OrgApiClient session refresh', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('awaits the async session provider so expired tokens get refreshed before the request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const getValidSession = vi.fn().mockResolvedValue(session({ accessToken: 'fresh-token' }))
    const client = new OrgApiClient(getValidSession)

    await client.listSkills()

    expect(getValidSession).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer fresh-token')
  })

  it('retries once with a refreshed session when a signed-in request comes back 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const getValidSession = vi
      .fn()
      .mockResolvedValueOnce(session({ accessToken: 'stale-token' }))
      .mockResolvedValueOnce(session({ accessToken: 'fresh-token' }))
    const client = new OrgApiClient(getValidSession)

    await client.reportLifecycle('a', 'install')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-token')
  })

  it('surfaces the error when the retry also fails with 401', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    // 两次调用返回不同 token 才会触发重试（相同 token 视为刷新不可用，直接失败）
    const client = new OrgApiClient(
      vi
        .fn()
        .mockResolvedValueOnce(session({ accessToken: 'stale-token' }))
        .mockResolvedValueOnce(session({ accessToken: 'fresh-token' }))
    )

    // reportLifecycle 吞掉请求错误（不阻塞主流程），这里断言它确实重试过一次
    await client.reportLifecycle('a', 'install')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// 原公共目录契约停用：技能/连接器改为认证读取，由服务端按当前用户分组过滤。
describe('OrgApiClient grouped catalog access', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('rejects skill listing without issuing a request when signed out', async () => {
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    await expect(client.listSkills()).rejects.toThrow('未登录')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps modern skill library items to the desktop catalog contract', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 7,
              slug: '7',
              name: 'demo',
              description: 'demo skill',
              version: '2026-10-15T00:00:00.000Z',
              contentHash: 'hash-7',
              downloadUrl: '/api/library-items/7/download?format=binary'
            }
          ]
        }),
        { status: 200 }
      )
    )
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'tok' })))

    const result = await client.listSkills()

    expect(result.skills).toEqual([
      expect.objectContaining({
        slug: '7',
        contentHash: 'hash-7',
        downloadUrl: '/api/library-items/7/download?format=binary'
      })
    ])
    expect(fetchMock.mock.calls[0][0]).toContain('/api/library-items?page=1&pageSize=100')
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer tok')
  })

  it('loads every ready skill page and excludes unavailable items', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      slug: String(index + 1),
      name: `skill-${index + 1}`,
      description: '',
      version: 'v1',
      contentHash: `hash-${index + 1}`,
      downloadUrl: `/api/library-items/${index + 1}/download?format=binary`,
      status: 'ready'
    }))
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: pageOne, total: 102 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 101,
                slug: '101',
                name: 'ready-last',
                description: '',
                version: 'v1',
                contentHash: 'hash-101',
                downloadUrl: '/api/library-items/101/download?format=binary',
                status: 'ready'
              },
              {
                id: 102,
                slug: '102',
                name: 'failed',
                description: '',
                version: 'v1',
                contentHash: 'hash-102',
                downloadUrl: '/api/library-items/102/download?format=binary',
                status: 'failed'
              }
            ],
            total: 102
          }),
          { status: 200 }
        )
      )
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'tok' })))

    const result = await client.listSkills()

    expect(result.skills).toHaveLength(101)
    expect(result.skills.at(-1)?.slug).toBe('101')
    expect(fetchMock.mock.calls[1][0]).toContain('page=2')
  })

  it('maps modern MCP servers to the desktop connector contract', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 3,
              key: 'filesystem',
              config: {
                name: 'Filesystem',
                description: 'Local files',
                type: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem']
              }
            }
          ]
        }),
        { status: 200 }
      )
    )
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'tok' })))

    const result = await client.listConnectors()

    expect(result.connectors).toEqual([
      expect.objectContaining({
        slug: 'filesystem',
        name: 'Filesystem',
        description: 'Local files',
        type: 'stdio',
        baseUrl: '',
        config: expect.objectContaining({ command: 'npx' })
      })
    ])
    expect(fetchMock.mock.calls[0][0]).toContain('/api/mcp-servers')
  })

  it('skips lifecycle report without a request when signed out (best-effort semantics)', async () => {
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    // reportLifecycle 吞错不阻塞主流程；匿名时等价于"跳过"：resolve 且不发请求
    await expect(client.reportLifecycle('a', 'install')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
