/**
 * [enterprise] JavaAuthClient 契约测试：login/me/logout 使用原始 token 头、
 * 原生 code 解析、RSA PKCS1 密码加密。真实公钥仅在测试内存中生成，不作生产默认。
 */
import { generateKeyPairSync, privateDecrypt } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { JavaAuthClient, encryptPassword, normalizeJavaMe } from '../JavaAuthClient'

function makeKey(): { publicKeyBase64: string; decrypt: (cipher: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    publicKeyBase64,
    decrypt: (cipher) => privateDecrypt({ key: privateKey, padding: 1 }, Buffer.from(cipher, 'base64')).toString('utf8')
  }
}

const BASE = 'https://java.example'

describe('JavaAuthClient RSA password encryption', () => {
  it('encrypts only the password and the ciphertext is decryptable by the paired private key', async () => {
    const key = makeKey()
    const cipher = encryptPassword(key.publicKeyBase64, 's3cret-password')

    expect(cipher).not.toContain('s3cret-password')
    expect(key.decrypt(cipher)).toBe('s3cret-password')
  })

  it('rejects a missing or malformed public key without falling back to plaintext', () => {
    expect(() => encryptPassword('', 'pw')).toThrow(/公钥/)
    expect(() => encryptPassword('not-base64!!!', 'pw')).toThrow(/公钥/)
  })
})

describe('JavaAuthClient envelope and code handling', () => {
  it.each([
    { code: 10001, msg: '账号或密码错误', expected: '账号或密码错误' },
    { code: 10001, msg: '登录密码解密失败', expected: '登录密码解密失败' },
    { code: 10001, msg: null, expected: '请求被拒绝，请检查输入或联系管理员' },
    { code: 10001, msg: '\u0000', expected: '请求被拒绝，请检查输入或联系管理员' },
    { code: 10001, msg: '账号\n或密码错误', expected: '账号 或密码错误' },
    { code: 500, msg: 'captcha required /internal/secret', expected: '认证服务异常，请稍后重试或联系管理员' },
    { code: 10007, msg: 'captcha required', expected: '无权限执行此操作，请联系管理员' },
    { code: 10008, msg: '请输入验证码', expected: '会话已失效，请重新登录' },
    {
      code: 10009,
      msg: 'captcha required',
      expected: '验证码错误或已过期，当前客户端暂不支持验证码登录，请联系管理员'
    },
    { code: 12345, msg: 'internal secret', expected: '认证服务返回未知业务码（12345），请联系管理员' }
  ])('按统一业务码显示准确提示而非通用失败：$code $msg', async ({ expected, ...body }) => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ ...body, data: null, requestId: 'req-123' }))
    })
    await expect(client.fetchMe('raw')).rejects.toThrow(`${expected}（请求ID：req-123）`)
  })

  it('非字符串msg及非法requestId不导致类型错误或泄露响应', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ code: 10001, msg: {}, requestId: '<secret>' }))
    })
    await expect(client.fetchMe('raw')).rejects.toThrow('请求被拒绝，请检查输入或联系管理员')
  })

  it.each([
    { code: 10009, msg: '操作失败' },
    { code: 10009, msg: '无权限' }
    // 旧用例按msg关键词覆盖10007/10008/500，已停用，业务码必须优先。
    // { code: 10007, msg: 'captcha required' },
    // { code: 10008, msg: '请输入验证码' },
    // { code: 500, msg: 'captcha required' }
  ])('原生验证码错误提供中文提示：%j', async (envelope) => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope)))
    })
    await expect(client.fetchMe('raw')).rejects.toThrow(/验证码/)
  })

  it('服务端英文验证码要求转为中文阻断提示', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 10009, msg: 'captcha required' })))
    })
    await expect(client.fetchMe('raw')).rejects.toThrow(/验证码/)
  })
  it('显示名优先于用户名', () => {
    expect(
      normalizeJavaMe({
        serverInstanceId: 'i',
        id: 'u',
        tenantId: 't',
        roleCode: 'member',
        username: 'alice',
        showName: '显示名称',
        groupId: null
      }).username
    ).toBe('显示名称')
  })
  it('拒绝 HTTP 失败中伪装成成功的业务响应', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 200,
            data: { serverInstanceId: 'i', id: 'u', tenantId: 't', roleCode: 'member' }
          }),
          { status: 500 }
        )
      )
    })
    await expect(client.fetchMe('raw')).rejects.toThrow(/认证服务请求失败/)
  })

  it.each(['null', '[]', '{}'])('拒绝无效信封 %s 并提供中文错误', async (body) => {
    const client = new JavaAuthClient({ baseUrl: BASE, fetchImpl: vi.fn().mockResolvedValue(new Response(body)) })
    await expect(client.fetchMe('raw')).rejects.toThrow(/认证响应格式无效/)
  })

  it('用户名保持明文，只有密码加密且不携带 Cookie', async () => {
    const key = makeKey()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          data: { accessToken: 'raw', currentTenant: { tenantId: 12 } }
        })
      )
    )
    const client = new JavaAuthClient({ baseUrl: BASE, publicKeyBase64: key.publicKeyBase64, fetchImpl })
    expect(await client.login('alice', '密码')).toEqual({ accessToken: 'raw', tenantId: '12' })
    const init = fetchImpl.mock.calls[0][1]!
    const body = JSON.parse(init.body as string)
    expect(body.username).toBe('alice')
    expect(key.decrypt(body.password)).toBe('密码')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })
  it('normalizes a code=200 /me response including a nullable group', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            serverInstanceId: 'inst-1',
            id: 'user-1',
            username: 'Alice',
            tenantId: 'tenant-1',
            roleCode: 'member',
            groupId: null
          }
        }),
        { status: 200 }
      )
    )
    const client = new JavaAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as never })

    const profile = await client.fetchMe('raw-token')

    expect(profile).toMatchObject({
      serverInstanceId: 'inst-1',
      userId: 'user-1',
      username: 'Alice',
      tenantId: 'tenant-1',
      roleCode: 'member',
      groupId: null
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/v1/auth/me`,
      expect.objectContaining({ method: 'GET', headers: { token: 'raw-token' }, credentials: 'omit' })
    )
  })

  it('does not normalize a non-200 HTTP response', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 500 })) as never
    })
    await expect(client.fetchMe('raw-token')).rejects.toThrow()
  })

  it('maps code 10008 to an expired-session error', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      publicKeyBase64: makeKey().publicKeyBase64,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ code: 10008, message: 'expired' }), { status: 200 })) as never
    })
    await expect(client.login('u', 'p')).rejects.toThrow(/会话已失效/)
  })

  it('10007 表示无权限，不误报密码错误或会话过期', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      publicKeyBase64: makeKey().publicKeyBase64,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ code: 10007, msg: '无权限' }), { status: 200 })) as never
    })
    const result = client.login('u', 'p')
    await expect(result).rejects.toThrow(/无权限/)
    await expect(result).rejects.not.toThrow(/密码|会话已失效/)
  })

  it('fails closed on unparseable JSON', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(new Response('not json', { status: 200 })) as never
    })
    await expect(client.fetchMe('raw-token')).rejects.toThrow(/无法解析/)
  })

  it('fails closed when the login response lacks an access token', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      publicKeyBase64: makeKey().publicKeyBase64,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 200, data: { tenantId: 't' } }), { status: 200 })
        ) as never
    })
    await expect(client.login('u', 'p')).rejects.toThrow(/访问令牌/)
  })

  it('fails closed when /me lacks an enterprise or instance identifier', async () => {
    const client = new JavaAuthClient({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 200, data: { id: 'user-1', tenantId: 't', roleCode: 'member' } }), {
          status: 200
        })
      ) as never
    })
    await expect(client.fetchMe('raw-token')).rejects.toThrow(/server_instance_id/)
  })

  it('rejects a JSON number id that lost integer precision', async () => {
    expect(() =>
      normalizeJavaMe({
        serverInstanceId: 'inst-1',
        id: Number('9007199254740993'),
        tenantId: 't',
        roleCode: 'member'
      })
    ).toThrow(/安全整数/)
  })

  it.each([
    {},
    { groupId: undefined },
    { groupId: '' },
    { groupId: '  ' },
    { groupId: false },
    { groupId: {} },
    { groupId: [] },
    { groupId: -1 },
    { groupId: 1.5 },
    { groupId: Number.MAX_SAFE_INTEGER + 1 },
    { group_id: 'legacy' },
    { groupId: '', group_id: 'legacy' }
  ])('拒绝缺失或非法 group，不回退旧别名：%j', (group) => {
    expect(() =>
      normalizeJavaMe({ serverInstanceId: 'i', id: 'u', tenantId: 't', roleCode: 'member', ...group } as never)
    ).toThrow(/group_id/)
  })

  it.each([
    { groupId: null, group_id: 'legacy', expected: null },
    { groupId: 'group-1', expected: 'group-1' },
    { groupId: 0, expected: '0' },
    { groupId: 12, expected: '12' }
  ])('仅真实 null 或有效 groupId 合法：%j', ({ expected, ...group }) => {
    expect(
      normalizeJavaMe({ serverInstanceId: 'i', id: 'u', tenantId: 't', roleCode: 'member', ...group }).groupId
    ).toBe(expected)
  })

  it.each(['login', 'fetchMe', 'logout'] as const)('%s 的超时覆盖响应 body 读取', async (method) => {
    const key = method === 'login' ? makeKey().publicKeyBase64 : undefined
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const text = vi.fn()
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        signal = init!.signal!
        text.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              signal!.addEventListener('abort', () => reject(new Error('响应读取超时')), { once: true })
            })
        )
        return { ok: true, status: 200, text } as unknown as Response
      })
      const client = new JavaAuthClient({ baseUrl: BASE, publicKeyBase64: key, fetchImpl, timeoutMs: 50 })
      const result = (method === 'login' ? client.login('u', 'p') : client[method]('raw')).catch((error) => error)
      await vi.advanceTimersByTimeAsync(49)
      expect(text).toHaveBeenCalledOnce()
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal?.aborted).toBe(true)
      expect(await result).toBeInstanceOf(Error)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs out without sending a refresh token and reports HTTP 200 success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    const client = new JavaAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as never })

    expect(await client.logout('raw-token')).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/v1/auth/logout`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ token: 'raw-token' })
      })
    )
  })
})
