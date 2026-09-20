/**
 * [enterprise] 企业服务端地址构建期可配置测试
 * MAIN_VITE_ORG_SERVER_BASE_URL 未配置时回退 T0 联调默认值；配置后规范化为 origin，
 * 非法值在模块加载时直接抛错（构建/测试尽早失败，而非运行时指向错误服务端）。
 * 三处写死地址收敛到 ORG_SERVER_BASE_URL 单一出口，登录与技能下载共用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ORG_SERVER_BASE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('falls back to the T0 local default when the env var is unset or blank', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', '')
    vi.resetModules()
    const { ORG_SERVER_BASE_URL } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_SERVER_BASE_URL).toBe('http://127.0.0.1:3000')
  })

  it('normalizes a configured deployment base URL to its origin', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', ' https://org.example.com/api/ ')
    vi.resetModules()
    const { ORG_SERVER_BASE_URL } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_SERVER_BASE_URL).toBe('https://org.example.com')
  })

  it('rejects a malformed configured URL at module load', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'not a url')
    vi.resetModules()
    const importConfigured = () => import('@main/enterprise/OrgApiClient')

    await expect(importConfigured()).rejects.toThrow('MAIN_VITE_ORG_SERVER_BASE_URL 不是合法 URL')
  })
})
