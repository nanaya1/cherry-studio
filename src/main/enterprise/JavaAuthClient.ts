/**
 * [enterprise] Java Sa-Token 原生认证专用客户端。
 * 与旧业务请求（OrgApiClient 的 Bearer/共享传输）严格隔离：本模块只服务于
 * 认证三接口 login/me/logout，且使用 `token:` 原始头而非 Authorization/Bearer。
 * 仅 username 明文、password 经 RSA/ECB/PKCS1Padding 加密为 Base64；公钥由构建注入，
 * 不获取/保存私钥，不新增公钥接口；缺公钥或格式错误时中文报错，绝不降级明文。
 */
import { constants, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto'

import { loggerService } from '@logger'

import { javaResponseErrorMessage } from './JavaResponseError'
import type { JavaAuthEnvelope, JavaAuthProfile, JavaLoginData, JavaMeData } from './types'

const logger = loggerService.withContext('JavaAuthClient')

const DEFAULT_TIMEOUT_MS = 30_000

/** RSA/ECB/PKCS1Padding 加密密码为 Base64。公钥为构建注入的 Java SPKI/DER Base64。 */
export function encryptPassword(publicKeyBase64: string, password: string): string {
  if (!publicKeyBase64 || !publicKeyBase64.trim()) {
    throw new Error('未配置企业登录公钥，无法加密密码')
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new Error('企业登录公钥格式无效，请联系管理员')
  }
  try {
    const ciphertext = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8'))
    return ciphertext.toString('base64')
  } catch {
    throw new Error('密码加密失败，请稍后重试')
  }
}

function requireId(name: string, value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} 超出了安全整数范围，服务端返回值可能已丢失精度`)
    }
    return String(value)
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} 不能为空`)
  return value
}

function requireNonEmpty(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} 不能为空`)
  return value
}

function nullableGroup(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('group_id 超出了安全整数范围，服务端返回值可能已丢失精度')
    }
    return String(value)
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error('group_id 必须为有效标识或 null')
  return value
}

/** 将 /me 的 data 归一化为身份与授权；拒绝缺字段、缺企业、危险数字 id、非安全组取值。 */
export function normalizeJavaMe(data: JavaMeData): JavaAuthProfile {
  const serverInstanceId = requireId('server_instance_id', data.serverInstanceId)
  const userId = requireId('user.id', data.id ?? data.userId)
  const tenantId = requireId('tenantId', data.tenantId)
  const roleCode = requireNonEmpty('role', data.roleCode ?? data.role)
  const groupId = nullableGroup(data.groupId)
  const username =
    (typeof data.showName === 'string' && data.showName.trim()) ||
    (typeof data.username === 'string' && data.username.trim()) ||
    null
  return { serverInstanceId, userId, username, tenantId, roleCode, groupId }
}

function assertSuccessCode(envelope: JavaAuthEnvelope): void {
  if (envelope.code === 200) return
  // 旧关键词判断及统一失败提示停用，严格按Java业务码分类。
  // throw new Error('认证服务调用失败，请稍后重试或联系管理员')
  throw new Error(javaResponseErrorMessage(envelope.code, envelope.msg, envelope.requestId, '认证'))
}

export interface JavaAuthClientOptions {
  baseUrl: string
  publicKeyBase64?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class JavaAuthClient {
  private readonly baseUrl: string
  private readonly publicKeyBase64?: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: JavaAuthClientOptions) {
    this.baseUrl = options.baseUrl
    this.publicKeyBase64 = options.publicKeyBase64
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 用户名明文 + 密码 RSA 加密登录；返回 accessToken 与登录返回的租户标识（用于与 /me 一致性校验）。 */
  async login(username: string, password: string): Promise<{ accessToken: string; tenantId: string | null }> {
    const encrypted = encryptPassword(this.publicKeyBase64 ?? '', password)
    const envelope = await this.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: encrypted })
      },
      (response) => this.parseJson(response) as Promise<JavaAuthEnvelope<JavaLoginData>>
    )
    assertSuccessCode(envelope)
    const data = envelope.data
    if (!data || typeof data.accessToken !== 'string' || data.accessToken.length === 0) {
      throw new Error('登录响应缺少访问令牌')
    }
    const tenantId = requireId('tenantId', data.currentTenant?.tenantId ?? data.tenantId)
    return { accessToken: data.accessToken, tenantId }
  }

  /** 使用原始 token 头拉取 /me 并归一化身份与授权；code200 且企业有效才进入解析。 */
  async fetchMe(accessToken: string): Promise<JavaAuthProfile> {
    const envelope = await this.request(
      '/api/v1/auth/me',
      {
        method: 'GET',
        headers: { token: accessToken }
      },
      (response) => this.parseJson(response) as Promise<JavaAuthEnvelope<JavaMeData>>
    )
    assertSuccessCode(envelope)
    if (!envelope.data) throw new Error('/me 响应缺少用户数据')
    return normalizeJavaMe(envelope.data)
  }

  /** 原生无参数登出；仅携带原始 token 头，不发送 refreshToken。返回是否业务成功（code200）。 */
  async logout(accessToken: string): Promise<boolean> {
    return this.request(
      '/api/v1/auth/logout',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', token: accessToken }
      },
      async (response) => {
        if (!response.ok) return false
        const envelope = await this.parseJson(response)
        return envelope.code === 200
      }
    )
  }

  private async parseJson(response: Response): Promise<JavaAuthEnvelope> {
    if (!response.ok) throw new Error(`认证服务请求失败（${response.status}）`)
    const text = await response.text().catch(() => '')
    let body: unknown
    try {
      body = JSON.parse(text || 'null')
    } catch {
      throw new Error('服务端返回了无法解析的响应')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('code' in body) || !Number.isInteger(body.code)) {
      throw new Error('认证响应格式无效')
    }
    return body as JavaAuthEnvelope
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    readResponse: (response: Response) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      logger.info('java auth request', { method: init.method, path })
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      })
      return await readResponse(response)
    } finally {
      clearTimeout(timer)
    }
  }
}
