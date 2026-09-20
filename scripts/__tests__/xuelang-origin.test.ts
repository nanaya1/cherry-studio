import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveXuelangApiOrigin } from '../../electron.vite.config'

// The define-injected global must stay optional at runtime: vitest projects do not
// inherit vite `define`, so the shared constant falls back to the production default.
describe('resolveXuelangApiOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('falls back to the production default when unset or blank', () => {
    expect(resolveXuelangApiOrigin(undefined)).toBe('https://api.xuelanglm.com')
    expect(resolveXuelangApiOrigin('   ')).toBe('https://api.xuelanglm.com')
  })

  it('normalizes a configured deployment origin', () => {
    expect(resolveXuelangApiOrigin(' https://gw.example.com/some/path ')).toBe('https://gw.example.com')
    expect(resolveXuelangApiOrigin('http://internal.local:8443')).toBe('http://internal.local:8443')
  })

  it('rejects values that are not a valid http(s) URL', () => {
    expect(() => resolveXuelangApiOrigin('not a url')).toThrow('XUELANG_API_ORIGIN is not a valid URL')
    expect(() => resolveXuelangApiOrigin('ftp://gw.example.com')).toThrow('XUELANG_API_ORIGIN must use http(s)')
  })

  it('injects the shell-configured origin into both process builds', async () => {
    vi.stubEnv('XUELANG_API_ORIGIN', 'https://gw.example.com')
    vi.resetModules()
    const { default: electronViteConfig } = await import('../../electron.vite.config')
    const config = electronViteConfig as unknown as {
      main: { define: Record<string, string> }
      renderer: { define: Record<string, string> }
    }
    const expected = JSON.stringify('https://gw.example.com')

    expect(config.main.define.__XUELANG_API_ORIGIN__).toBe(expected)
    expect(config.renderer.define.__XUELANG_API_ORIGIN__).toBe(expected)
  })
})
