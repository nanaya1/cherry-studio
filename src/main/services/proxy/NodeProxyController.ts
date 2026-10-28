import type { NodeProxyLogger } from './bypassRules'
import type { NodeProxyBackend } from './NodeProxyBackend'
import {
  buildNodeProxyEnvironment,
  CHERRY_NODE_PROXY_BYPASS_RULES_ENV,
  CHERRY_NODE_PROXY_RULES_ENV,
  type NodeProxyConfig,
  normalizeProxyBypassRules
} from './proxyEnv'
import { normalizeProxyEndpoint } from './proxyRouting'

const PROXY_ENV_KEYS = [
  CHERRY_NODE_PROXY_RULES_ENV,
  CHERRY_NODE_PROXY_BYPASS_RULES_ENV,
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'grpc_proxy',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'SOCKS_PROXY',
  'socks_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

// 进程级共享后端：跨实例复用，重建时不重复包裹全局、不重置代理。
let sharedBackendPromise: Promise<NodeProxyBackend> | null = null
let sharedConfigKey: string | null = null

export class NodeProxyController {
  // private currentConfigKey: string | null = null
  // private backendPromise: Promise<NodeProxyBackend> | undefined

  constructor(private logger?: NodeProxyLogger) {}

  // Backend is process-level (see sharedBackendPromise) so the last proxy config
  // survives profile rebuilds and rebuilds never stack wrappers.
  private getBackend(): Promise<NodeProxyBackend> {
    sharedBackendPromise ??= import('./NodeProxyBackend').then(
      ({ NodeProxyBackend }) => new NodeProxyBackend(this.logger)
    )
    return sharedBackendPromise
  }

  async configure(config: NodeProxyConfig): Promise<void> {
    const proxyUrl = config.proxyRules?.trim()
    const normalizedBypassRules = normalizeProxyBypassRules(config.proxyBypassRules)
    // Keep local services reachable independently of the configured proxy.
    if (proxyUrl) {
      for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
        if (!normalizedBypassRules.includes(hostname)) normalizedBypassRules.push(hostname)
      }
    }
    const configKey = JSON.stringify({ proxyUrl: proxyUrl ?? null, proxyBypassRules: normalizedBypassRules })
    // if (this.currentConfigKey === configKey) return
    if (sharedConfigKey === configKey) return

    const proxyEndpoint = normalizeProxyEndpoint(proxyUrl)
    if (proxyEndpoint) {
      await this.getBackend().then((backend) =>
        backend.configure(proxyUrl, proxyEndpoint, normalizedBypassRules, () =>
          this.setEnvironment(proxyUrl, normalizedBypassRules)
        )
      )
    } else if (sharedBackendPromise) {
      // 原逻辑（保留）：else if (this.backendPromise)。后端已共享，按共享引用判断。
      await sharedBackendPromise.then((backend) =>
        backend.configure(undefined, null, normalizedBypassRules, () =>
          this.setEnvironment(undefined, normalizedBypassRules)
        )
      )
    } else {
      this.setEnvironment(undefined, normalizedBypassRules)
    }

    // this.currentConfigKey = configKey
    sharedConfigKey = configKey
  }

  /*
  private getBackend(): Promise<NodeProxyBackend> {
    this.backendPromise ??= import('./NodeProxyBackend').then(
      ({ NodeProxyBackend }) => new NodeProxyBackend(this.logger)
    )
    return this.backendPromise
  }
  */

  private setEnvironment(url: string | undefined, normalizedBypassRules: string[]): void {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    if (!url) return

    const env = buildNodeProxyEnvironment({ proxyRules: url, proxyBypassRules: normalizedBypassRules })
    for (const [key, value] of Object.entries(env)) process.env[key] = value
  }
}
