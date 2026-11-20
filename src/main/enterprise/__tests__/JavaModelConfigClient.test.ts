import { afterEach, describe, expect, it, vi } from 'vitest'

import { ENDPOINT_TYPE } from '@shared/data/types/model'

import { JavaModelConfigClient, parseJavaModelConfigEnvelope } from '../JavaModelConfigClient'
import { OrgApiClient } from '../OrgApiClient'
import type { JavaModelConfigSnapshot, OrgSession } from '../types'

const chat = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
const session: OrgSession = {
  authMode: 'management-java',
  accountKind: 'management',
  issuerId: 'server-a',
  authOrigin: 'https://cowork.test',
  userId: '7',
  tenantId: '9',
  groupId: null,
  role: 'MEMBER',
  displayName: null,
  phone: '',
  officialUserId: '',
  accessToken: 'login-token',
  expiresAt: null
}

function snapshot(): JavaModelConfigSnapshot {
  return {
    serverInstanceId: 'server-a',
    userId: '7',
    tenantId: '9',
    providers: [
      {
        id: 'key-42',
        name: 'Cowork 开发',
        apiKey: 'sk-client-example',
        defaultChatEndpoint: chat,
        endpointConfigs: { [chat]: { baseUrl: 'https://models.test/v1' } },
        models: [{ id: 'chat-model', name: '对话模型', endpointTypes: [chat] }]
      }
    ]
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('JavaModelConfigClient', () => {
  it('使用当前会话的原始 token 读取专用接口，且不缓存明文配置', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: snapshot() }))
    vi.stubGlobal('fetch', fetchImpl)
    const client = new OrgApiClient(async () => session)
    const result = await client.getModelConfig(session, () => undefined)

    expect(result).toEqual(snapshot())
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://cowork.test/api/v1/client/model/config')
    expect(new Headers(init?.headers).get('token')).toBe('login-token')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' })
  })

  it('只允许完整快照或明确的成功空列表', () => {
    expect(parseJavaModelConfigEnvelope({ code: 200, data: { ...snapshot(), providers: [] } }).providers).toEqual([])
    for (const value of [null, {}, { code: 200 }, { code: 200, data: {} }, { code: 200, data: { providers: null } }]) {
      expect(() => parseJavaModelConfigEnvelope(value)).toThrow()
    }
  })

  it.each([
    (data: JavaModelConfigSnapshot) => {
      data.providers.push(data.providers[0])
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].models.push(data.providers[0].models[0])
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].apiKey = 'sk-****'
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].endpointConfigs[chat]!.baseUrl = 'https://user:secret@models.test'
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].endpointConfigs[chat]!.baseUrl = 'file:///tmp/key'
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].endpointConfigs[chat]!.baseUrl = 'https://models.test?token=secret'
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].models[0].endpointTypes = []
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].models[0].endpointTypes = [ENDPOINT_TYPE.OPENAI_RESPONSES]
    },
    (data: JavaModelConfigSnapshot) => {
      data.providers[0].models[0].id = 'bad?model'
    }
  ])('拒绝非法或不完整的配置，不将错误当成撤销授权', (mutate) => {
    const data = snapshot()
    mutate(data)
    expect(() => parseJavaModelConfigEnvelope({ code: 200, data })).toThrow('快照不完整')
  })

  it.each([9007199254740992, 42])('标识必须是字符串，拒绝数字 %s', (userId) => {
    expect(() => parseJavaModelConfigEnvelope({ code: 200, data: { ...snapshot(), userId } })).toThrow()
  })

  it('拒绝未知协议，保留明确声明的多协议模型', () => {
    const data = snapshot()
    data.providers[0].endpointConfigs[ENDPOINT_TYPE.ANTHROPIC_MESSAGES] = { baseUrl: 'https://models.test/v1' }
    data.providers[0].models[0].endpointTypes.push(ENDPOINT_TYPE.ANTHROPIC_MESSAGES)
    expect(parseJavaModelConfigEnvelope({ code: 200, data }).providers[0].models[0].endpointTypes).toEqual([
      chat,
      ENDPOINT_TYPE.ANTHROPIC_MESSAGES
    ])
    expect(() =>
      parseJavaModelConfigEnvelope({
        code: 200,
        data: { ...data, providers: [{ ...data.providers[0], defaultChatEndpoint: 'unknown-protocol' }] }
      })
    ).toThrow()
  })

  it.each([10007, 500, 10008])('业务码 %s 失败不返回空列表，仅 10008 撤销会话', async (code) => {
    const expired = vi.fn()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code, msg: 'sk-secret', requestId: 'r1' }))
    const client = new JavaModelConfigClient({
      baseUrl: session.authOrigin,
      getAccessToken: async () => session.accessToken,
      onSessionExpired: expired,
      fetchImpl
    })
    const error = await client.getConfig().catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('sk-secret')
    expect(expired).toHaveBeenCalledTimes(code === 10008 ? 1 : 0)
  })

  it('过期响应在租约失效后不能撤销新的登录身份', async () => {
    let active = true
    let complete!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          })
      )
    )
    const expired = vi.fn()
    const client = new OrgApiClient(async () => session, undefined, expired)
    const operation = client.getModelConfig(session, () => {
      if (!active) throw new Error('stale lease')
    })
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    active = false
    complete(Response.json({ code: 10008 }))
    await expect(operation).rejects.toThrow('stale lease')
    expect(expired).not.toHaveBeenCalled()
  })

  it('读取响应正文也受超时限制，不泄露解析异常中的正文', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('sk-secret')))
            })
        }) as Response
    )
    const client = new JavaModelConfigClient({
      baseUrl: session.authOrigin,
      getAccessToken: async () => session.accessToken,
      onSessionExpired: () => undefined,
      fetchImpl,
      timeoutMs: 50
    })
    const operation = client.getConfig().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(String(await operation)).toContain('超时')
    expect(String(await operation)).not.toContain('sk-secret')
  })
})
