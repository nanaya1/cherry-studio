import { OPENAI_CODEX_PROVIDER_ID } from '@shared/data/presets/codex'
import { GROK_CLI_PROVIDER_ID } from '@shared/data/presets/grokCli'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import { createGatewayOAuthProvider } from './providers/cherryin'
import { codexOAuthProvider } from './providers/codex'
import { grokOAuthProvider } from './providers/grok'
import type { OAuthRuntimeProviderDefinition } from './types'

/**
 * Registry of OAuth runtime definitions, one entry per login-based provider.
 * Each provider's config + flow lives in its own `providers/<id>.ts`; this file
 * only wires them onto their provider ids. Add a provider by dropping a new file
 * in `providers/` and registering it here. Gateway providers (CherryIN,
 * 雪浪工匠) share the gateway factory and differ only by provider id.
 */
export const oauthProviderDefinitions = {
  [OPENAI_CODEX_PROVIDER_ID]: codexOAuthProvider,
  [GROK_CLI_PROVIDER_ID]: grokOAuthProvider,
  [SystemProviderIds.cherryin]: createGatewayOAuthProvider(SystemProviderIds.cherryin),
  [SystemProviderIds.xuelang]: createGatewayOAuthProvider(SystemProviderIds.xuelang)
} satisfies Record<string, OAuthRuntimeProviderDefinition>

export type OAuthProviderId = keyof typeof oauthProviderDefinitions
