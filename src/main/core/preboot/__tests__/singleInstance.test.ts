import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Tests for src/main/core/preboot/singleInstance.ts
 *
 * Mocking strategy (mirrors crashTelemetry.test.ts):
 *   - `electron` is shadowed per test; only `app.requestSingleInstanceLock`
 *     is needed. The return value is toggled via a shared vi.fn().
 *   - `@application` is shadowed per test with a stub that
 *     exposes only `quit()` — the global mock in tests/main.setup.ts
 *     does not provide it.
 *   - `process.exit` is a Node global. We temporarily replace it with a
 *     stub that throws a sentinel error so the test can observe the
 *     call without actually terminating the test runner, and restore it
 *     in afterEach. The sentinel is caught by `expect(...).toThrow()`.
 *   - `@logger` is already globally mocked; no per-test mock needed.
 */

class ProcessExitSentinel extends Error {
  constructor(public readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)}) called`)
  }
}

const requestSingleInstanceLockMock = vi.fn<() => boolean>(() => true)
const appOnMock = vi.fn()
const getAllWindowsMock = vi.fn<() => unknown[]>(() => [])
const applicationQuitMock = vi.fn()
const processExitMock = vi.fn<(code?: number | string | null) => never>((code) => {
  throw new ProcessExitSentinel(code)
})

const originalProcessExit = process.exit.bind(process)

function stubElectron() {
  vi.doMock('electron', () => ({
    __esModule: true,
    app: {
      requestSingleInstanceLock: requestSingleInstanceLockMock,
      on: appOnMock
    },
    BrowserWindow: {
      getAllWindows: getAllWindowsMock
    }
  }))
}

function stubApplication() {
  vi.doMock('@application', () => ({
    application: {
      quit: applicationQuitMock
    }
  }))
}

async function loadModule() {
  return import('../singleInstance')
}

beforeEach(() => {
  vi.resetModules()
  requestSingleInstanceLockMock.mockReset().mockReturnValue(true)
  appOnMock.mockReset()
  getAllWindowsMock.mockReset().mockReturnValue([])
  applicationQuitMock.mockReset()
  processExitMock.mockReset().mockImplementation((code) => {
    throw new ProcessExitSentinel(code)
  })
  // Swap process.exit with our observable stub.
  ;(process as unknown as { exit: typeof processExitMock }).exit = processExitMock
})

afterEach(() => {
  ;(process as unknown as { exit: typeof originalProcessExit }).exit = originalProcessExit
})

describe('requireSingleInstance', () => {
  it('returns normally when the single-instance lock is acquired', async () => {
    requestSingleInstanceLockMock.mockReturnValue(true)
    stubElectron()
    stubApplication()

    const { requireSingleInstance } = await loadModule()
    expect(() => requireSingleInstance()).not.toThrow()

    expect(requestSingleInstanceLockMock).toHaveBeenCalledTimes(1)
    expect(applicationQuitMock).not.toHaveBeenCalled()
    expect(processExitMock).not.toHaveBeenCalled()
  })

  it('brings the existing window to the front when a second instance is rejected', async () => {
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    getAllWindowsMock.mockReturnValue([window])
    stubElectron()
    stubApplication()

    const { requireSingleInstance } = await loadModule()
    requireSingleInstance()

    const handler = appOnMock.mock.calls.find(([event]) => event === 'second-instance')?.[1] as (() => void) | undefined
    expect(handler).toBeTypeOf('function')
    handler?.()

    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('普通二次启动跳过排在首位的隐藏预热窗口并唤醒可见窗口', async () => {
    const standby = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    const visible = { ...standby, isVisible: () => true, show: vi.fn(), focus: vi.fn() }
    getAllWindowsMock.mockReturnValue([standby, visible])
    stubElectron()
    stubApplication()
    const { requireSingleInstance } = await loadModule()
    requireSingleInstance()

    appOnMock.mock.calls.find(([event]) => event === 'second-instance')![1]({}, ['app.exe'])

    expect(standby.show).not.toHaveBeenCalled()
    expect(standby.focus).not.toHaveBeenCalled()
    expect(visible.focus).toHaveBeenCalledOnce()
  })

  it.each(['meacowork://oauth/callback?code=test&state=test', 'meacowork://auth?code=test'])(
    '协议回调 %s 不通过通用监听器显示窗口且继续传递给其他监听器',
    async (url) => {
      const window = {
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => true,
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn()
      }
      getAllWindowsMock.mockReturnValue([window])
      stubElectron()
      stubApplication()
      const { requireSingleInstance } = await loadModule()
      requireSingleInstance()
      const protocolHandler = vi.fn()
      appOnMock('second-instance', protocolHandler)
      const argv = ['app.exe', url]
      for (const [event, handler] of appOnMock.mock.calls) {
        if (event === 'second-instance') handler({}, argv)
      }

      expect(window.restore).not.toHaveBeenCalled()
      expect(window.show).not.toHaveBeenCalled()
      expect(window.focus).not.toHaveBeenCalled()
      expect(protocolHandler).toHaveBeenCalledWith({}, argv)
    }
  )

  it('does not reveal a hidden bootstrap before ready-to-show', async () => {
    const window = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn()
    }
    getAllWindowsMock.mockReturnValue([window])
    stubElectron()
    stubApplication()
    const { requireSingleInstance, deferWindowReveal } = await loadModule()
    deferWindowReveal(window as any)
    requireSingleInstance()
    appOnMock.mock.calls.find(([event]) => event === 'second-instance')![1]()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('只有隐藏待用窗口时普通重启不显示任何窗口', async () => {
    const window = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn()
    }
    getAllWindowsMock.mockReturnValue([window])
    stubElectron()
    stubApplication()
    const { requireSingleInstance } = await loadModule()
    requireSingleInstance()

    appOnMock.mock.calls.find(([event]) => event === 'second-instance')![1]({}, ['app.exe'])

    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('bootstrap 就绪后可唤醒已显示窗口且最小化窗口不依赖 isVisible', async () => {
    let visible = false
    const window = {
      isDestroyed: () => false,
      isVisible: () => visible,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    getAllWindowsMock.mockReturnValue([window])
    stubElectron()
    stubApplication()
    const { requireSingleInstance, deferWindowReveal } = await loadModule()
    const allowReveal = deferWindowReveal(window as any)
    requireSingleInstance()
    const handler = appOnMock.mock.calls.find(([event]) => event === 'second-instance')![1]
    handler({}, ['app.exe'])
    expect(window.restore).not.toHaveBeenCalled()
    allowReveal()
    handler({}, ['app.exe'])
    expect(window.restore).toHaveBeenCalledOnce()
    visible = true
    handler({}, ['app.exe'])
    expect(window.focus).toHaveBeenCalledTimes(2)
  })

  it('calls application.quit() and process.exit(0) when the lock is denied', async () => {
    requestSingleInstanceLockMock.mockReturnValue(false)
    stubElectron()
    stubApplication()

    const { requireSingleInstance } = await loadModule()
    expect(() => requireSingleInstance()).toThrow(ProcessExitSentinel)

    expect(requestSingleInstanceLockMock).toHaveBeenCalledTimes(1)
    expect(applicationQuitMock).toHaveBeenCalledTimes(1)
    expect(processExitMock).toHaveBeenCalledTimes(1)
    expect(processExitMock).toHaveBeenCalledWith(0)
  })

  it('invokes application.quit() before process.exit() so the shared quit path runs first', async () => {
    requestSingleInstanceLockMock.mockReturnValue(false)
    stubElectron()
    stubApplication()

    const { requireSingleInstance } = await loadModule()
    expect(() => requireSingleInstance()).toThrow(ProcessExitSentinel)

    const quitOrder = applicationQuitMock.mock.invocationCallOrder[0]
    const exitOrder = processExitMock.mock.invocationCallOrder[0]
    expect(quitOrder).toBeLessThan(exitOrder)
  })
})
