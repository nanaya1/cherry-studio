/** Cowork 模型配置仅在主进程读取，登录 token 不进入模型调用链路。 */
import * as z from 'zod'

import { ENDPOINT_TYPE, objectValues } from '@shared/data/types/model'

import { javaResponseErrorMessage } from './JavaResponseError'
import type { JavaModelConfigSnapshot } from './types'

const endpointTypeSchema = z.enum(objectValues(ENDPOINT_TYPE))
const nonEmptyText = z.string().trim().min(1)
const textEndpointSchema = z.enum([
  ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  ENDPOINT_TYPE.OPENAI_RESPONSES,
  ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
  ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT
])
const baseUrlSchema = nonEmptyText.refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
})
const providerSchema = z
  .object({
    id: nonEmptyText,
    name: nonEmptyText,
    apiKey: nonEmptyText.refine((value) => !/[*•…\r\n]/.test(value)),
    defaultChatEndpoint: textEndpointSchema,
    endpointConfigs: z.partialRecord(endpointTypeSchema, z.object({ baseUrl: baseUrlSchema })),
    models: z.array(
      z.object({
        id: nonEmptyText.refine((value) => !/[?#]/.test(value)),
        name: nonEmptyText.optional(),
        endpointTypes: z.array(endpointTypeSchema).min(1)
      })
    )
  })
  .refine((provider) => {
    if (!provider.endpointConfigs[provider.defaultChatEndpoint]) return false
    if (new Set(provider.models.map((model) => model.id)).size !== provider.models.length) return false
    return provider.models.every(
      (model) =>
        new Set(model.endpointTypes).size === model.endpointTypes.length &&
        model.endpointTypes.every((endpoint) => provider.endpointConfigs[endpoint] !== undefined)
    )
  })
const snapshotSchema = z
  .object({
    serverInstanceId: nonEmptyText,
    userId: nonEmptyText,
    tenantId: nonEmptyText,
    providers: z.array(providerSchema)
  })
  .refine((snapshot) => new Set(snapshot.providers.map((provider) => provider.id)).size === snapshot.providers.length)

export interface JavaModelConfigClientOptions {
  baseUrl: string
  getAccessToken: () => Promise<string>
  onSessionExpired: () => void | Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class JavaModelConfigError extends Error {
  constructor(
    public readonly code: number,
    requestId?: unknown
  ) {
    // 不透传包含凭据的任意服务端 msg。
    super(javaResponseErrorMessage(code, undefined, requestId, '模型服务'))
    this.name = 'JavaModelConfigError'
  }
}

/** 完整校验成功快照；错误信息不包含原始响应或 Zod 的字段值。 */
export function parseJavaModelConfigEnvelope(value: unknown): JavaModelConfigSnapshot {
  const envelope = z
    .object({ code: z.number().int(), data: z.unknown(), requestId: z.unknown().optional() })
    .safeParse(value)
  if (!envelope.success) throw new Error('模型配置响应格式无效')
  if (envelope.data.code !== 200) throw new JavaModelConfigError(envelope.data.code, envelope.data.requestId)
  const parsed = snapshotSchema.safeParse(envelope.data.data)
  if (!parsed.success) throw new Error('模型配置快照不完整或字段无效')
  return parsed.data
}

export class JavaModelConfigClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: JavaModelConfigClientOptions) {
    this.baseUrl = new URL(options.baseUrl).origin
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async getConfig(): Promise<JavaModelConfigSnapshot> {
    const accessToken = await this.options.getAccessToken()
    if (!accessToken) throw new Error('未登录')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000)
    try {
      // MEA:enterprise-model-binding 明文凭据只进入专用服务商存储，禁止通用缓存和重定向。
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/client/model/config`, {
        method: 'GET',
        headers: { accept: 'application/json', token: accessToken },
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store'
      })
      if (!response.ok) {
        if (response.status === 401) await this.options.onSessionExpired()
        throw new Error(`模型配置请求失败 (${response.status})`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error('模型配置响应不是有效 JSON')
      }
      return parseJavaModelConfigEnvelope(body)
    } catch (error) {
      if (controller.signal.aborted) throw new Error('模型配置请求超时，请重试')
      if (error instanceof JavaModelConfigError && error.code === 10008) await this.options.onSessionExpired()
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
