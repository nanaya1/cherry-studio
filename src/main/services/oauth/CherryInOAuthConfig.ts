import { XUELANG_API_HOST } from '@shared/utils/constants'
import * as z from 'zod'

/**
 * Per-provider gateway OAuth configuration. CherryIN and 雪浪工匠 ride the same
 * gateway stack, so every provider shares the PKCE contract (client_id /
 * redirect / scopes) and differs only in the allowed API hosts. Update the
 * xuelang hosts when the production auth server domain lands.
 */
const XUELANG_PRODUCTION = {
  CLIENT_ID: '2a348c87-bae1-4756-a62f-b2e97200fd6d',
  ALLOWED_HOSTS: [XUELANG_API_HOST],
  REDIRECT_URI: 'meacowork://oauth/callback',
  // 2026-09-14：雪浪服务端暂不签发 id_token，原 openid scope 注释保留并移除。
  // SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
  SCOPES: 'profile email offline_access balance:read usage:read tokens:read tokens:write'
} as const

const XUELANG_LOCAL = {
  CLIENT_ID: 'sub2api-local-94989e7183d30c37',
  ALLOWED_HOSTS: ['https://localhost:18443'],
  REDIRECT_URI: 'meacowork://oauth/callback',
  // 2026-09-14：本地雪浪联调与生产保持同一 scope 契约。
  // SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
  SCOPES: 'profile email offline_access balance:read usage:read tokens:read tokens:write'
} as const

/** Local Snowwave overrides are opt-in and only consumed by an unpackaged dev build. */
export const getXuelangOAuthConfig = (isPackaged: boolean) =>
  !isPackaged && process.env.XUELANG_LOCAL_OAUTH === '1' ? XUELANG_LOCAL : XUELANG_PRODUCTION

export const GATEWAY_OAUTH_CONFIGS = {
  cherryin: {
    CLIENT_ID: '2a348c87-bae1-4756-a62f-b2e97200fd6d',
    ALLOWED_HOSTS: ['https://open.cherryin.ai', 'https://open.cherryin.dev'],
    REDIRECT_URI: 'meacowork://oauth/callback',
    SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
  },
  xuelang: XUELANG_PRODUCTION
} as const

export type GatewayProviderId = keyof typeof GATEWAY_OAUTH_CONFIGS

export const isGatewayProviderId = (providerId: string): providerId is GatewayProviderId =>
  providerId in GATEWAY_OAUTH_CONFIGS

/** @deprecated Legacy CherryIN-only alias; prefer {@link GATEWAY_OAUTH_CONFIGS}. */
export const CHERRYIN_CONFIG = GATEWAY_OAUTH_CONFIGS.cherryin

export function validateGatewayApiHost(providerId: GatewayProviderId, apiHost: string): void {
  if (!(GATEWAY_OAUTH_CONFIGS[providerId].ALLOWED_HOSTS as readonly string[]).includes(apiHost)) {
    throw new CherryInOAuthServiceError(`Unauthorized API host: ${apiHost}`)
  }
}

/** @deprecated CherryIN-only host validation; prefer {@link validateGatewayApiHost}. */
export function validateCherryInApiHost(apiHost: string): void {
  validateGatewayApiHost('cherryin', apiHost)
}

export class CherryInOAuthServiceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'CherryInOAuthServiceError'
  }
}

const ApiKeyItemSchema = z
  .union([z.string(), z.object({ key: z.string() }), z.object({ token: z.string() })])
  .transform((item): string => {
    if (typeof item === 'string') return item
    if ('key' in item) return item.key
    return item.token
  })

export const ApiKeysResponseSchema = z
  .union([z.array(ApiKeyItemSchema), z.object({ data: z.array(ApiKeyItemSchema) })])
  .transform((data): string[] => (Array.isArray(data) ? data : data.data))
