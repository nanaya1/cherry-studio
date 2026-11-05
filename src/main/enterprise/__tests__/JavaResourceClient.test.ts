import { describe, expect, it, vi } from 'vitest'

import { JavaResourceClient } from '../JavaResourceClient'

const envelope = (data: unknown, code = 200) => Response.json({ code, msg: '测试响应', data })
const skill = (id: number, enabled = 1) => ({
  id,
  tenantId: null,
  slug: 'same-name',
  name: '技能',
  displayName: '公共技能',
  description: '',
  version: '1.0',
  contentHash: 'a'.repeat(64),
  packageFileCode: 'package-code',
  iconFileCode: null,
  enabled,
  status: 'active',
  categories: [],
  tagItems: [{ code: 'test', name: '测试' }],
  tags: 'not,an,array'
})
function setup(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response)
  const onSessionExpired = vi.fn()
  const client = new JavaResourceClient({
    baseUrl: 'https://enterprise.test',
    getAccessToken: async () => 'secret-token',
    fetchImpl,
    onSessionExpired
  })
  return { client, fetchImpl, onSessionExpired }
}

describe('JavaResourceClient', () => {
  it('业务提示显示msg和请求ID且不注销当前会话', async () => {
    const { client, onSessionExpired } = setup([
      Response.json({ code: 10001, msg: '技能已停用', data: null, requestId: 'req-resource' })
    ])
    await expect(client.listSkills()).rejects.toThrow('技能已停用（请求ID：req-resource）')
    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('资源系统错误不透传内部诊断', async () => {
    const { client } = setup([Response.json({ code: 500, msg: 'secret internal', requestId: 'req-500' })])
    await expect(client.listSkills()).rejects.toThrow('企业资源服务异常，请稍后重试（请求ID：req-500）')
  })

  it('图标只返回受控图片dataURL，不暴露文件标识或token', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const { client } = setup([new Response(png, { headers: { 'content-type': 'image/png' } })])
    expect(await client.readIcon('private-icon')).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })

  it('错误图片类型和超过上限的图片回退默认头像', async () => {
    const { client } = setup([
      new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } }),
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })
    ])
    expect(await client.readIcon('svg')).toBeNull()
    expect(await client.readIcon('large')).toBeNull()
  })

  it('按原始页数取完技能，再过滤状态，保留同slug的独立ID', async () => {
    const first = Array.from({ length: 100 }, (_, i) => skill(i + 1, 0))
    const { client, fetchImpl } = setup([
      envelope({ items: first, total: 102 }),
      envelope({ items: [skill(101), { ...skill(102), tenantId: 9 }], total: 102 })
    ])
    const items = await client.listSkills()
    expect(items.map((item) => item.id)).toEqual(['101', '102'])
    expect(items[0].name).toBe('公共技能')
    expect(items[0].tags).toEqual([{ code: 'test', name: '测试' }])
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://enterprise.test/api/v1/skill/page?page=1&pageSize=100&scope=all',
      'https://enterprise.test/api/v1/skill/page?page=2&pageSize=100&scope=all'
    ])
    const init = fetchImpl.mock.calls[0][1]!
    expect(new Headers(init.headers).get('token')).toBe('secret-token')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('拒绝已失真的整数资源ID', async () => {
    const { client } = setup([envelope({ items: [skill(Number.MAX_SAFE_INTEGER + 1)], total: 1 })])
    await expect(client.listSkills()).rejects.toThrow('资源ID')
  })

  it('权限不足不注销，会话失效才通知认证层', async () => {
    const { client, onSessionExpired } = setup([envelope(null, 10007), envelope(null, 10008)])
    await expect(client.listConnectors()).rejects.toThrow('无权限')
    expect(onSessionExpired).not.toHaveBeenCalled()
    await expect(client.listConnectors()).rejects.toThrow('重新登录')
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('连接器严格映射类型且顶层字段覆盖configJson', async () => {
    const { client } = setup([
      envelope([
        {
          id: 7,
          tenantId: 9,
          slug: 'same-name',
          displayName: '企业连接器',
          description: '说明',
          transportType: 'streamable_http',
          baseUrl: 'https://mcp.test/api',
          configJson: JSON.stringify({ name: '过时名称', type: 'sse', baseUrl: 'https://old.test' }),
          enabled: 1,
          status: 'active',
          iconFileCode: null
        }
      ])
    ])
    const [item] = await client.listConnectors()
    expect(item).toMatchObject({ id: '7', tenantId: '9', name: '企业连接器', type: 'streamableHttp' })
    expect(item.config).toMatchObject({ name: '企业连接器', type: 'streamableHttp', baseUrl: 'https://mcp.test/api' })
    expect(JSON.stringify(item)).not.toContain('secret-token')
  })

  it.each(['{broken', '[]', 'null'])('坏配置不悄悄回退SSE：%s', async (configJson) => {
    const { client } = setup([
      envelope([
        {
          id: 7,
          tenantId: null,
          slug: 'bad',
          displayName: '错误连接器',
          transportType: 'sse',
          configJson,
          enabled: 1,
          status: 'active'
        }
      ])
    ])
    const [item] = await client.listConnectors()
    expect(item.configurationError).toBeTruthy()
    expect(item.config).toEqual({})
  })

  it('未知连接类型标记不可安装，不回退SSE', async () => {
    const { client } = setup([
      envelope([
        {
          id: 7,
          tenantId: null,
          slug: 'bad',
          transportType: 'unknown',
          configJson: '{}',
          enabled: 1,
          status: 'active'
        }
      ])
    ])
    expect((await client.listConnectors())[0].configurationError).toBeTruthy()
  })

  it('文件接口HTTP200业务错误不能当作ZIP返回', async () => {
    const { client } = setup([envelope(null, 10007)])
    await expect(client.readFile('private-code')).rejects.toThrow('无权限')
  })

  it('文件标识只能编码成同源路径片段', async () => {
    const { client, fetchImpl } = setup([
      new Response(new Uint8Array([80, 75]), {
        headers: { 'content-type': 'application/zip' }
      })
    ])
    expect((await client.readFile('code/with?query')).bytes).toEqual(Buffer.from([80, 75]))
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://enterprise.test/api/v1/file/view/code%2Fwith%3Fquery')
  })

  it('生命周期仅发送契约载荷，同一事件重试不改eventId', async () => {
    const { client, fetchImpl } = setup([envelope(null, 500), envelope(null)])
    const event = {
      id: '7',
      eventId: 'a'.repeat(32),
      event: 'install' as const,
      version: '1.0',
      contentHash: 'b'.repeat(64)
    }
    await expect(client.reportLifecycle(event)).rejects.toThrow()
    await client.reportLifecycle(event)
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([
      { ...event, id: 7 },
      { ...event, id: 7 }
    ])
  })

  it('文件缺少Content-Type时仍识别业务错误JSON', async () => {
    const { client } = setup([new Response(JSON.stringify({ code: 10008, data: null }))])
    await expect(client.readFile('private-code')).rejects.toThrow('重新登录')
  })

  it('响应头返回后，读取文件正文仍受超时限制', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            }
          }),
          { headers: { 'content-type': 'application/zip' } }
        )
    )
    const client = new JavaResourceClient({
      baseUrl: 'https://enterprise.test',
      getAccessToken: async () => 'secret-token',
      onSessionExpired: vi.fn(),
      fetchImpl,
      timeoutMs: 10
    })
    await expect(client.readFile('private-code')).rejects.toThrow('超时')
  })

  it('拒绝空技能包摘要，避免未验证内容进入安装链路', async () => {
    const { client } = setup([envelope({ items: [{ ...skill(1), contentHash: '' }], total: 1 })])
    await expect(client.listSkills()).rejects.toThrow('摘要')
  })
})
