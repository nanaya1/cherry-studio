/**
 * 复现用户现象：多次错误配置 → 连通后 raw <tool_call> XML → 换 key 短暂正常再复发
 * → 删除模型重新获取（reconcile）恢复。
 *
 * 本测试走【真实】链路（不 mock 核心被验证链）：
 *   - 真实 DB（setupTestDatabase 执行生产迁移）
 *   - 真实 ProviderService / ModelService 创建 / 更新 / 删除 / reconcile
 *   - 真实网关地址解析 resolveGatewayModelAddress（每次实时读 DB）
 *   - 真实 SDK 配置解析 resolveSdkConfig → buildOpenAICompatibleConfig
 *   - 真实 @cherrystudio/ai-core generateText → 真实本地 127.0.0.1 模拟 OpenAI 接口
 *
 * 唯一被 mock 的是传输层 customFetch（Electron net.fetch 在 Vitest 下无 Chromium，
 * 改为 globalThis.fetch 以便本地回环 server 可达），这与 listModels.integration.test.ts
 * 一致，且不属于“配置→SDK→HTTP”这一被验证链。
 *
 * 本文件为新增文件，不修改任何既有生产/测试代码。
 */

import { createServer, type Server } from 'node:http'

import { setupTestDatabase } from '@test-helpers/db'
import { jsonSchema } from 'ai'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateText } from '@cherrystudio/ai-core'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import type * as ProviderRegistryServiceModule from '@data/services/ProviderRegistryService'
import { providerService } from '@data/services/ProviderService'
import { resolveEffectiveEndpoint } from '@main/ai/provider/endpoint'
import { resolveSdkConfig } from '@main/ai/provider/sdkConfig'
import type { AppProviderSettingsMap } from '@main/ai/types'
import type * as CustomFetchModule from '@main/ai/utils/customFetch'
import { resolveGatewayModelAddress } from '@main/features/apiGateway/utils/models'
import { ENDPOINT_TYPE, MODEL_CAPABILITY } from '@shared/data/types/model'

// ── 仅 mock 传输层：让本地回环 server 在 Vitest 下可达 ──
vi.mock('@main/ai/utils/customFetch', async () => {
  const actual = await vi.importActual<typeof CustomFetchModule>('@main/ai/utils/customFetch')
  return {
    ...actual,
    customFetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)
  }
})

// ── ModelService 的 registry 富化依赖 providerRegistryService.resolveModel ──
// 仅覆盖 resolveModel，保留真实的 getProviderDisplayMetadata / getProviderPreset /
// mergeEndpointConfigs（ProviderService.create 需要它们）。
const { resolveModelMock } = vi.hoisted(() => ({
  // resolveModelMock: vi.fn<any, any>(() => ({
  resolveModelMock: vi.fn(() => ({
    providerModel: null,
    registryOverride: null,
    reasoningProfile: { format: 'openai-chat', wire: { disabled: true } }
  }))
}))

vi.mock('@data/services/ProviderRegistryService', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderRegistryServiceModule>()
  return {
    ...actual,
    providerRegistryService: {
      ...actual.providerRegistryService,
      resolveModel: resolveModelMock
    }
  }
})

// ── 让自定义 provider id 在 registry 中没有预设（自定义 relay） ──
vi.mock('@cherrystudio/provider-registry/node', () => ({
  RegistryLoader: class {
    loadProviders() {
      return []
    }
    loadModels() {
      return []
    }
    loadProviderModels() {
      return []
    }
    findModel() {
      return null
    }
    findOverride() {
      return null
    }
  }
}))

// ── 本地模拟 OpenAI 兼容接口 ──
type ServerMode = 'normal_text' | 'tool_calls' | 'text_xml'

interface RequestCapture {
  port: number
  url: string
  auth: string | undefined
  body: unknown
}

function buildResponse(mode: ServerMode): unknown {
  if (mode === 'tool_calls') {
    return {
      id: 'cmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ location: 'Beijing' }) }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    }
  }
  if (mode === 'text_xml') {
    // 上游直接把工具调用作为裸文本返回（模拟错误 relay / 缓存串台）
    return {
      id: 'cmpl-2',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '<tool_call>get_weather({"location":"Beijing"})</tool_call>'
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    }
  }
  return {
    id: 'cmpl-3',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

function makeServer(state: { mode: ServerMode }): { server: Server; requests: RequestCapture[] } {
  const requests: RequestCapture[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown = null
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : -1
      requests.push({ port, url: req.url ?? '', auth: req.headers['authorization'], body })
      res.setHeader('content-type', 'application/json')
      res.statusCode = 200
      res.end(JSON.stringify(buildResponse(state.mode)))
    })
  })
  return { server, requests }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not expose a TCP port')
  return addr.port
}

// 工具定义：用于验证“标准 tool_calls 应保持结构化”
const WEATHER_TOOL = {
  get_weather: {
    description: 'Get the current weather for a location',
    parameters: jsonSchema({
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location']
    })
  }
}

const PROVIDER_ID = 'repro-relay'
const MODEL_ID = 'repro-model'
const GATEWAY_ADDRESS = `${PROVIDER_ID}:${MODEL_ID}`

describe('apiGateway 配置错误 → 换 key → 删除重拉 恢复 复现', () => {
  const dbh = setupTestDatabase()
  const servers: Server[] = []

  afterEach(async () => {
    vi.clearAllMocks()
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve())
          })
      )
    )
  })

  it('错误地址失败并纠正 / 新 key 生效 / 连续工具调用保持结构化 / 删除重拉使用最新配置', async () => {
    const state = { mode: 'normal_text' as ServerMode }
    const s1 = makeServer(state)
    const s2 = makeServer(state)
    servers.push(s1.server, s2.server)
    const P = await listen(s1.server)
    const P3 = await listen(s2.server)

    // 真实创建 provider。初始使用【错误地址】（端口 9 无监听）与初始 key。
    const WRONG_PORT = 9
    providerService.create({
      providerId: PROVIDER_ID,
      name: 'Repro Relay',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: `http://127.0.0.1:${WRONG_PORT}` }
      },
      apiKeys: [{ id: 'k0', key: 'sk-init', isEnabled: true }]
    })
    // 新建 provider 默认 isEnabled=false，网关要求启用
    providerService.update(PROVIDER_ID, { isEnabled: true })

    // 真实创建 model（网关可路由：provider id 不含 ':'，chat 能力）
    modelService.create([
      {
        dto: {
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          name: 'Repro Model',
          endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS],
          capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
          supportsStreaming: true
        }
      }
    ])

    async function resolveAndGenerate() {
      // 真实网关地址解析：每次都实时从 DB 读 provider/model
      const addr = resolveGatewayModelAddress(GATEWAY_ADDRESS)
      const resolvedEndpoint = resolveEffectiveEndpoint(addr.provider, addr.model)
      // 真实 SDK 配置解析 → openai-compatible provider 配置
      const { sdkConfig } = await resolveSdkConfig(addr.provider, addr.model, resolvedEndpoint)
      // const result = await generateText(sdkConfig.providerId, sdkConfig.providerSettings as any, {
      const result = await generateText<AppProviderSettingsMap>(sdkConfig.providerId, sdkConfig.providerSettings, {
        model: sdkConfig.modelId,
        prompt: 'hello',
        tools: WEATHER_TOOL
      } as any)
      return { sdkConfig, result }
    }

    // ── 阶段 1：错误地址 → 连接失败 ──
    await expect(resolveAndGenerate()).rejects.toThrow(/ECONNREFUSED|fetch failed|connect/i)

    // ── 阶段 2：纠正地址到正确 server（P） → 成功，请求打到正确端口 ──
    providerService.update(PROVIDER_ID, {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: `http://127.0.0.1:${P}` }
      }
    })
    state.mode = 'normal_text'
    const phaseB = await resolveAndGenerate()
    expect(phaseB.result.text).toBe('ok')
    const lastB = s1.requests[s1.requests.length - 1]
    expect(lastB.port).toBe(P)
    expect(lastB.url).toContain('/v1') // formatApiHost 默认追加 /v1

    // ── 阶段 3：换 key → 新 key 实际生效（短暂正常） ──
    providerService.replaceApiKeys(PROVIDER_ID, [{ id: 'k1', key: 'sk-newkey', isEnabled: true }])
    const phaseC = await resolveAndGenerate()
    expect(phaseC.result.text).toBe('ok')
    const lastC = s1.requests[s1.requests.length - 1]
    expect(lastC.auth).toBe('Bearer sk-newkey')

    // ── 阶段 4：连续工具调用 → 标准 tool_calls 保持【结构化】，不出现裸 XML ──
    state.mode = 'tool_calls'
    const call1 = await resolveAndGenerate()
    const call2 = await resolveAndGenerate()
    for (const call of [call1, call2]) {
      expect(call.result.toolCalls?.length ?? 0).toBeGreaterThan(0)
      const tc = call.result.toolCalls[0] as any
      expect(tc.toolName).toBe('get_weather')
      expect(tc.args).toMatchObject({ location: 'Beijing' })
      // 关键：结构化工具调用不应以裸 <tool_call> XML 文本形式透传
      expect(call.result.text ?? '').not.toContain('<tool_call>')
    }

    // ── 阶段 5：删除模型 + 重新获取（reconcile）→ 使用【最新】provider 配置恢复 ──
    // 先模拟“再次变更配置”：切到第三个端口 P3 + 第三个 key（即用户再次修正）
    providerService.update(PROVIDER_ID, {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: `http://127.0.0.1:${P3}` }
      }
    })
    providerService.replaceApiKeys(PROVIDER_ID, [{ id: 'k2', key: 'sk-recover', isEnabled: true }])
    // 删除模型
    modelService.delete(PROVIDER_ID, MODEL_ID)
    // 重新获取（reconcile）：真实 ModelService 重插模型行
    modelService.reconcileForProvider(PROVIDER_ID, {
      toAdd: [
        {
          dto: {
            providerId: PROVIDER_ID,
            modelId: MODEL_ID,
            name: 'Repro Model',
            endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS],
            capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
            supportsStreaming: true
          }
        }
      ],
      toRemove: []
    })
    state.mode = 'normal_text'
    const phaseE = await resolveAndGenerate()
    expect(phaseE.result.text).toBe('ok')
    // reconcile 后网关重新解析，应命中最新端口 P3 与最新 key（证明无陈旧缓存）
    const lastE = s2.requests[s2.requests.length - 1]
    expect(lastE.port).toBe(P3)
    expect(lastE.auth).toBe('Bearer sk-recover')

    // ── 阶段 6（对照）：上游直接返回裸 <tool_call> 文本 → 仅文本透传，
    //     这不是“客户端缓存 bug”的复现证据，而是上游文本直通 ──
    state.mode = 'text_xml'
    const phaseF = await resolveAndGenerate()
    expect(phaseF.result.text ?? '').toContain('<tool_call>')
    expect(phaseF.result.toolCalls?.length ?? 0).toBe(0)

    // 落库校验：真实 DB 中 provider 使用最新端口，model 已重建
    const [providerRow] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, PROVIDER_ID))
    expect((providerRow?.endpointConfigs as any)?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.baseUrl).toBe(
      `http://127.0.0.1:${P3}`
    )
    const modelRows = await dbh.db.select().from(userModelTable).where(eq(userModelTable.providerId, PROVIDER_ID))
    expect(modelRows).toHaveLength(1)
  })
})
