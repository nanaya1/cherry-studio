import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

const mocks = vi.hoisted(() => ({ request: vi.fn(), listener: null as ((status: EnterpriseStatus) => void) | null }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request },
  useIpcOn: (_event: string, listener: NonNullable<typeof mocks.listener>) => {
    mocks.listener = listener
  }
}))

import { useOrgAccountSession } from '../useOrgAccountSession'

const signedOut: EnterpriseStatus = {
  phase: 'signed-out',
  authMode: 'management-oauth',
  displayName: null,
  phone: null,
  role: null
}
const authorizing = (id = 'a'): EnterpriseStatus => ({
  ...signedOut,
  phase: 'authorizing',
  loginAttemptId: id,
  loginStartedAt: Date.now()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.request
    .mockReset()
    .mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? signedOut : { unavailable: false }
    )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('企业登录窗口反馈', () => {
  it.each(['timeout', 'failed', 'denied'] as const)('初次打开及卸载重建不回放历史 %s', async (loginError) => {
    const current = { ...signedOut, loginError }
    mocks.request.mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? current : { unavailable: false }
    )
    const first = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(first.result.current.loadState).toBe('ready'))
    expect(first.result.current.loginError).toBeNull()
    await act(async () => mocks.listener?.(current))
    expect(first.result.current.loginError).toBe(loginError)
    first.unmount()
    const second = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(second.result.current.loadState).toBe('ready'))
    expect(second.result.current.loginError).toBeNull()
    expect(second.result.current.status).toEqual(current)
  })

  it.each(['timeout', 'failed', 'denied'] as const)('关闭清除 %s，重开不回放但新事件仍显示', async (loginError) => {
    const { result, rerender } = renderHook(({ open }) => useOrgAccountSession(open), { initialProps: { open: true } })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    const current = { ...signedOut, loginError }
    await act(async () => mocks.listener?.(current))
    expect(result.current.loginError).toBe(loginError)
    rerender({ open: false })
    expect(result.current.loginError).toBeNull()
    mocks.request.mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? current : { unavailable: false }
    )
    await act(async () => mocks.listener?.(current))
    expect(result.current.loginError).toBeNull()
    rerender({ open: true })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.loginError).toBeNull()
    await act(async () => mocks.listener?.(current))
    expect(result.current.loginError).toBe(loginError)
  })

  it.each(['login', 'cancel'] as const)('本次 %s 后的状态查询仍显示错误', async (action) => {
    let current = action === 'cancel' ? authorizing() : signedOut
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return current
      if (route === 'enterprise.login.start' || route === 'enterprise.login.cancel')
        current = { ...signedOut, loginError: 'failed' }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(() => (action === 'login' ? result.current.login() : result.current.cancelLogin()))
    expect(result.current.loginError).toBe('failed')
    expect(result.current.isLoggingIn).toBe(false)
  })

  it('新 start 请求失败仍反馈，关闭后的迟到失败不带到重开窗口', async () => {
    const { result, rerender } = renderHook(({ open }) => useOrgAccountSession(open), { initialProps: { open: true } })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    mocks.request.mockRejectedValueOnce(new Error('start failed'))
    await act(() => result.current.login())
    expect(result.current.loginError).toBe('failed')
    const start = deferred<void>()
    mocks.request.mockImplementationOnce(() =>
      start.promise.then(() => {
        throw new Error('late failure')
      })
    )
    let login!: Promise<void>
    act(() => {
      login = result.current.login()
    })
    rerender({ open: false })
    rerender({ open: true })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(async () => {
      start.resolve()
      await login
    })
    expect(result.current.loginError).toBeNull()
  })

  it('进行中关闭重开按原始时间恢复 60 秒提示且不取消', async () => {
    const current = { ...authorizing(), loginStartedAt: Date.now() - 59_000 }
    mocks.request.mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? current : { unavailable: false }
    )
    const { result, rerender } = renderHook(({ open }) => useOrgAccountSession(open), { initialProps: { open: true } })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.waitHintVisible).toBe(false)
    vi.useFakeTimers()
    rerender({ open: false })
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await act(async () => {
      rerender({ open: true })
    })
    expect(result.current.isLoggingIn).toBe(true)
    expect(result.current.waitHintVisible).toBe(true)
    expect(result.current.status?.loginAttemptId).toBe('a')
    expect(mocks.request).not.toHaveBeenCalledWith('enterprise.login.cancel', expect.anything())
  })
})

describe('企业登录等待', () => {
  it('authorizing 期间禁止再次 start，并按 attempt 取消', async () => {
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    act(() => mocks.listener?.(authorizing()))
    await act(() => result.current.login())
    expect(result.current.isLoggingIn).toBe(true)
    expect(mocks.request).not.toHaveBeenCalledWith('enterprise.login.start')
    await act(() => result.current.cancelLogin())
    expect(mocks.request).toHaveBeenCalledWith('enterprise.login.cancel', { attemptId: 'a' })
  })

  it('start 返回 URL 后仍等待状态，并同步拦截重复点击', async () => {
    const start = deferred<{ authorizationUrl: string }>()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return signedOut
      if (route === 'enterprise.login.start') return start.promise
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    let request!: Promise<void>
    act(() => {
      request = result.current.login()
      void result.current.login()
    })
    expect(mocks.request.mock.calls.filter(([route]) => route === 'enterprise.login.start')).toHaveLength(1)
    act(() => mocks.listener?.(authorizing()))
    await act(async () => {
      start.resolve({ authorizationUrl: 'https://example.test/oauth' })
      await request
    })
    expect(result.current.isLoggingIn).toBe(true)
    act(() => mocks.listener?.({ ...signedOut, phase: 'signed-in' }))
    expect(result.current.isLoggingIn).toBe(false)
  })

  it.each([true, false])('迟到取消 %s 及旧 start finally 不清理新 attempt 的 action', async (ok) => {
    const start = deferred<{ authorizationUrl: string }>()
    const cancel = deferred<{ ok: boolean }>()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return signedOut
      if (route === 'enterprise.login.start') return start.promise
      if (route === 'enterprise.login.cancel') return cancel.promise
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    act(() => {
      void result.current.login()
    })
    act(() => mocks.listener?.(authorizing()))
    const cancelA = result.current.cancelLogin
    act(() => mocks.listener?.(authorizing('b')))
    act(() => {
      void cancelA()
    })
    expect(mocks.request).not.toHaveBeenCalledWith('enterprise.login.cancel', { attemptId: 'b' })
    let request!: Promise<void>
    act(() => {
      request = result.current.cancelLogin()
    })
    await act(async () => {
      start.resolve({ authorizationUrl: 'https://example.test/oauth' })
      await start.promise
    })
    expect(result.current.isCancellingLogin).toBe(true)
    act(() => mocks.listener?.(authorizing('c')))
    await act(async () => {
      cancel.resolve({ ok })
      await request
    })
    expect(result.current.status?.loginAttemptId).toBe('c')
    expect(result.current.isLoggingIn).toBe(true)
  })

  it('旧 login finally 不能清除再次登录的等待状态', async () => {
    const first = deferred<{ authorizationUrl: string }>()
    const second = deferred<{ authorizationUrl: string }>()
    let starts = 0
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return signedOut
      if (route === 'enterprise.login.start') return ++starts === 1 ? first.promise : second.promise
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    act(() => {
      void result.current.login()
    })
    act(() => mocks.listener?.(authorizing()))
    act(() => mocks.listener?.(signedOut))
    act(() => {
      void result.current.login()
    })
    await act(async () => {
      first.resolve({ authorizationUrl: 'https://example.test/oauth' })
      await first.promise
    })
    expect(result.current.isLoggingIn).toBe(true)
    await act(() => result.current.login())
    expect(starts).toBe(2)
    await act(async () => {
      second.resolve({ authorizationUrl: 'https://example.test/oauth' })
      await second.promise
    })
  })

  it('取消成功恢复登录，取消失败保留等待以便重试', async () => {
    let ok = false
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return ok ? signedOut : authorizing()
      if (route === 'enterprise.login.cancel') {
        if (!ok) throw new Error('unavailable')
        return { ok: true }
      }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(() => result.current.cancelLogin())
    expect(result.current.isLoggingIn).toBe(true)
    expect(result.current.isCancellingLogin).toBe(false)
    ok = true
    await act(() => result.current.cancelLogin())
    expect(result.current.isLoggingIn).toBe(false)
    expect(result.current.status?.phase).toBe('signed-out')
  })

  it('start 的 authorizing 广播丢失后恢复 attempt，并允许取消', async () => {
    let current = signedOut
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return current
      if (route === 'enterprise.login.start') current = authorizing()
      if (route === 'enterprise.login.cancel') {
        current = signedOut
        return { ok: true }
      }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(() => result.current.login())
    expect(result.current.status?.loginAttemptId).toBe('a')
    expect(result.current.isLoggingIn).toBe(true)
    await act(() => result.current.cancelLogin())
    expect(result.current.isLoggingIn).toBe(false)
  })

  it('start 期间全部广播丢失时从权威终态清除 pending login', async () => {
    let current = signedOut
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return current
      if (route === 'enterprise.login.start') current = { ...signedOut, phase: 'signed-in' }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(() => result.current.login())
    expect(result.current.status?.phase).toBe('signed-in')
    expect(result.current.isLoggingIn).toBe(false)
    await act(() => result.current.logout())
    expect(mocks.request).toHaveBeenCalledWith('enterprise.session.logout')
  })

  it('start 后的迟到校准不能覆盖新 attempt 事件', async () => {
    const query = deferred<EnterpriseStatus>()
    let reads = 0
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return ++reads === 1 ? signedOut : query.promise
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    let login!: Promise<void>
    await act(async () => {
      login = result.current.login()
    })
    expect(reads).toBe(2)
    act(() => mocks.listener?.(authorizing('b')))
    await act(async () => {
      query.resolve(signedOut)
      await login
    })
    expect(result.current.status?.loginAttemptId).toBe('b')
  })

  it.each([true, false])('cancel 返回 %s 后读取权威已有 session，而非伪造 signed-out', async (ok) => {
    let current = authorizing()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return current
      if (route === 'enterprise.login.cancel') {
        current = { ...signedOut, phase: 'signed-in' }
        return { ok }
      }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    await act(() => result.current.cancelLogin())
    expect(result.current.status?.phase).toBe('signed-in')
    expect(result.current.isLoggingIn).toBe(false)
    expect(result.current.isCancellingLogin).toBe(false)
  })

  it.each([true, false])('cancel %s 的迟到校准不能覆盖新 attempt', async (ok) => {
    const query = deferred<EnterpriseStatus>()
    let reads = 0
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') return ++reads === 1 ? authorizing() : query.promise
      if (route === 'enterprise.login.cancel') return { ok }
      return { unavailable: false }
    })
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    let cancel!: Promise<void>
    await act(async () => {
      cancel = result.current.cancelLogin()
    })
    expect(reads).toBe(2)
    act(() => mocks.listener?.(authorizing('b')))
    await act(async () => {
      query.resolve(signedOut)
      await cancel
    })
    expect(result.current.status?.loginAttemptId).toBe('b')
    expect(result.current.isLoggingIn).toBe(true)
  })

  it('初始广播丢失后按主进程 deadline 单次校准，终态广播丢失也结束等待', async () => {
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    vi.useFakeTimers()
    const startedAt = Date.now() - 120_000
    let current: EnterpriseStatus = { ...authorizing(), loginStartedAt: startedAt }
    mocks.request.mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? current : { unavailable: false }
    )
    await act(() => result.current.login())
    current = { ...signedOut, loginError: 'timeout' }
    await act(() => vi.advanceTimersByTimeAsync(479_999))
    expect(result.current.isLoggingIn).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(result.current.isLoggingIn).toBe(false)
    expect(result.current.loginError).toBe('timeout')
    const reads = mocks.request.mock.calls.filter(([route]) => route === 'enterprise.status.get').length
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(mocks.request.mock.calls.filter(([route]) => route === 'enterprise.status.get')).toHaveLength(reads)
  })

  it('deadline 的迟到校准不能覆盖新 attempt', async () => {
    const { result } = renderHook(() => useOrgAccountSession())
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    vi.useFakeTimers()
    const query = deferred<EnterpriseStatus>()
    mocks.request.mockImplementation(async (route: string) =>
      route === 'enterprise.status.get' ? query.promise : { unavailable: false }
    )
    act(() => mocks.listener?.({ ...authorizing(), loginStartedAt: Date.now() - 599_000 }))
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(mocks.request.mock.calls.filter(([route]) => route === 'enterprise.status.get')).toHaveLength(2)
    act(() => mocks.listener?.(authorizing('b')))
    await act(async () => {
      query.resolve(signedOut)
    })
    expect(result.current.status?.loginAttemptId).toBe('b')
  })

  it('旧 status 查询不能覆盖状态事件', async () => {
    const status = deferred<EnterpriseStatus>()
    mocks.request.mockReturnValueOnce(status.promise)
    const { result } = renderHook(() => useOrgAccountSession())
    act(() => mocks.listener?.(authorizing()))
    await act(async () => {
      status.resolve(signedOut)
      await status.promise
    })
    expect(result.current.status?.phase).toBe('authorizing')
  })
})
