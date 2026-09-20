/**
 * [enterprise] C3 OrgAuthManager 登出/重登的 org 资源状态标记测试
 * logout → orgStateStore.markUnavailable；登录成功 → markAvailable。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { stateStoreMock } = vi.hoisted(() => ({
  stateStoreMock: {
    markUnavailable: vi.fn(),
    markAvailable: vi.fn(),
    snapshotUnavailable: vi.fn().mockReturnValue(false)
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@application', () => ({
  application: {
    get: vi.fn().mockReturnValue({ broadcast: vi.fn() })
  }
}))

vi.mock('@main/enterprise/OrgCredentialStore', () => ({
  OrgCredentialStore: class {
    load = vi.fn().mockReturnValue(null)
    save = vi.fn()
    clear = vi.fn()
  }
}))

vi.mock('@main/enterprise/OrgStateStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, orgStateStore: stateStoreMock }
})

import { OrgAuthManager } from '@main/enterprise/OrgAuthManager'

describe('OrgAuthManager C3 组织可用性标记', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // copy 模式下，登出只结束目录访问会话，不改变已复制到本地的资源状态。
  it('logout 不改变已安装资源的可用性', () => {
    const mgr = new OrgAuthManager()
    mgr.logout()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
  })

  it('登录成功不改变已安装资源的可用性', async () => {
    const mgr = new OrgAuthManager()
    // 走私有路径太绕：直接验证 doFinishLogin 逻辑不可行，改用 fetch mock 走完整回调
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 900,
          user: { id: 'u1', phone: '13900000000', role: 'normal_user' }
        })
    })
    globalThis.fetch = fetchMock as never

    // 注入 pending（模拟 startLogin 后收到回调）
    ;(mgr as unknown as { pending: unknown }).pending = {
      state: 'st',
      codeVerifier: 'cv',
      createdAt: Date.now()
    }

    const url = new URL('meacowork://auth/callback?code=c1&state=st')
    await mgr.handleAuthCallback(url)

    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
  })
})
