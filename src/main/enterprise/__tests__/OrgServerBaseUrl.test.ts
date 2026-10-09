/**
 * [enterprise] 企业服务端地址构建期可配置测试
 * MAIN_VITE_ORG_SERVER_BASE_URL 有值时规范化为 origin；未配置时使用官网直连模式。
 * 非法值在模块加载时直接抛错（构建/测试尽早失败，而非运行时指向错误服务端）。
 * 三处写死地址收敛到 ORG_SERVER_BASE_URL 单一出口，登录与技能下载共用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ORG_SERVER_BASE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('selects official direct mode when the management URL is unset or blank', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', '')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', 'https://official.example.com/login')
    vi.resetModules()
    const { ORG_AUTH_MODE, ORG_SERVER_BASE_URL } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_AUTH_MODE).toBe('official-direct')
    expect(ORG_SERVER_BASE_URL).toBeNull()
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
