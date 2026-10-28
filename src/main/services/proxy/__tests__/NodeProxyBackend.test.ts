import http from 'node:http'
import https from 'node:https'

import { getGlobalDispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'

import { NodeProxyBackend } from '../NodeProxyBackend'

// Captured before any backend wraps the process globals in this file.
const PRISTINE_HTTP_GET = http.get
const PRISTINE_DISPATCHER = getGlobalDispatcher()

function bindWithSharedAgent() {
  const backend = new NodeProxyBackend()
  const sharedProxyAgent = new https.Agent()
  const originalMethod = vi.fn()
  // bindHttpMethod is private; exercise the bound wrapper directly
  const bound = (backend as any).bindHttpMethod(originalMethod, sharedProxyAgent) as (...args: unknown[]) => unknown
  return { bound, originalMethod, sharedProxyAgent }
}

describe('NodeProxyBackend request binding', () => {
  it('propagates the caller agent TLS stance per-request without mutating the shared proxy agent', () => {
    const { bound, originalMethod, sharedProxyAgent } = bindWithSharedAgent()

    bound('https://example.test/backup', { agent: new https.Agent({ rejectUnauthorized: false }) })

    const forwardedOptions = originalMethod.mock.calls[0][1]
    expect(forwardedOptions.rejectUnauthorized).toBe(false)
    expect(forwardedOptions.agent).toBe(sharedProxyAgent)
    expect(sharedProxyAgent.options.rejectUnauthorized).not.toBe(false)
  })

  it('keeps a strict caller agent strict on the forwarded request', () => {
    const { bound, originalMethod, sharedProxyAgent } = bindWithSharedAgent()

    bound('https://example.test/backup', { agent: new https.Agent({ rejectUnauthorized: true }) })

    const forwardedOptions = originalMethod.mock.calls[0][1]
    expect(forwardedOptions.rejectUnauthorized).toBe(true)
    expect(sharedProxyAgent.options.rejectUnauthorized).not.toBe(false)
  })

  it('routes agentless requests through the shared proxy agent without injecting TLS options', () => {
    const { bound, originalMethod, sharedProxyAgent } = bindWithSharedAgent()

    bound('https://example.test/api', {})

    const forwardedOptions = originalMethod.mock.calls[0][1]
    expect(forwardedOptions.agent).toBe(sharedProxyAgent)
    expect('rejectUnauthorized' in forwardedOptions).toBe(false)
  })

  it('does not inject TLS options when the caller agent carries no explicit stance (default verifies)', () => {
    const { bound, originalMethod, sharedProxyAgent } = bindWithSharedAgent()

    bound('https://example.test/backup', { agent: new https.Agent() })

    const forwardedOptions = originalMethod.mock.calls[0][1]
    expect(forwardedOptions.agent).toBe(sharedProxyAgent)
    expect('rejectUnauthorized' in forwardedOptions).toBe(false)
  })
})

describe('NodeProxyBackend rebuild safety', () => {
  it('closes the retired dispatcher when changing the proxy', async () => {
    const backend = new NodeProxyBackend()
    const endpoint = { kind: 'http' as const, url: 'http://127.0.0.1:7890', displayOrigin: 'http://127.0.0.1:7890' }
    await backend.configure(endpoint.url, endpoint, [], () => {})
    const retired = getGlobalDispatcher()
    const closed = vi.spyOn(retired, 'close')
    try {
      await backend.configure(endpoint.url, endpoint, [], () => {})
      expect(getGlobalDispatcher()).not.toBe(retired)
      expect(closed).toHaveBeenCalledOnce()
    } finally {
      await backend.configure(undefined, null, [], () => {})
    }
  })
  it('restores the true original when a newer backend tears down while the old one still wraps', async () => {
    // First profile instance wraps the process globals.
    const first = new NodeProxyBackend()
    await first.configure(
      'http://127.0.0.1:7890',
      { kind: 'http', url: 'http://127.0.0.1:7890', displayOrigin: 'http://127.0.0.1:7890' },
      [],
      () => {}
    )

    // Rebuild: a second backend is constructed while the first still wraps globals.
    const second = new NodeProxyBackend()
    await second.configure(
      'http://127.0.0.1:7891',
      { kind: 'http', url: 'http://127.0.0.1:7891', displayOrigin: 'http://127.0.0.1:7891' },
      [],
      () => {}
    )

    // Tear down only the newer backend; the old one is never explicitly disposed.
    await second.configure(undefined, null, [], () => {})

    // Globals must return to the true original, not the orphaned first wrapper (no stacking).
    expect(http.get).toBe(PRISTINE_HTTP_GET)
    expect(getGlobalDispatcher()).toBe(PRISTINE_DISPATCHER)
  })
})
