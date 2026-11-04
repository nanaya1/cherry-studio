/**
 * [enterprise] 企业服务端地址构建期可配置测试
 * 默认回退到旧管理端 http://36.150.116.248:3000；MAIN_VITE_ORG_SERVER_BASE_URL 覆盖并归一化为 origin。
 * 认证模式固定为 management-oauth（PKCE），不再有官网直连模式。
 * 公共目录 getOrgApiBaseUrl 固定指向管理端，不回退官网配置。
 * 非法值在模块加载时直接抛错（构建/测试尽早失败，而非运行时指向错误服务端）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ORG_SERVER_BASE_URL / ORG_AUTH_MODE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('默认回退到旧管理端且模式为 management-oauth', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', '')
    vi.resetModules()
    const { ORG_AUTH_MODE, ORG_SERVER_BASE_URL, getOrgApiBaseUrl } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_AUTH_MODE).toBe('management-oauth')
    expect(ORG_SERVER_BASE_URL).toBe('http://36.150.116.248:3000')
    expect(getOrgApiBaseUrl()).toBe('http://36.150.116.248:3000')
  })

  it('normalizes a configured deployment base URL to its origin', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', ' https://org.example.com/api/ ')
    vi.resetModules()
    const { ORG_SERVER_BASE_URL, getOrgApiBaseUrl } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_SERVER_BASE_URL).toBe('https://org.example.com')
    expect(getOrgApiBaseUrl()).toBe('https://org.example.com')
  })

  it('rejects a malformed configured URL at module load', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'not a url')
    vi.resetModules()
    const importConfigured = () => import('@main/enterprise/OrgApiClient')

    await expect(importConfigured()).rejects.toThrow('MAIN_VITE_ORG_SERVER_BASE_URL 不是合法 URL')
  })

  it('无效的旧官网变量不影响管理端配置且模块可正常加载', async () => {
    // 官网直连模式已停用：MAIN_VITE_OFFICIAL_API_BASE_URL / MAIN_VITE_OFFICIAL_LOGIN_URL
    // 即使非法也不应再于模块加载时抛错导致启动崩溃。
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_API_BASE_URL', 'not a url')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', 'not a url')
    vi.resetModules()
    const { ORG_AUTH_MODE, ORG_SERVER_BASE_URL, getOrgApiBaseUrl } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_AUTH_MODE).toBe('management-oauth')
    expect(ORG_SERVER_BASE_URL).toBe('https://org.example.com')
    expect(getOrgApiBaseUrl()).toBe('https://org.example.com')
  })
})
