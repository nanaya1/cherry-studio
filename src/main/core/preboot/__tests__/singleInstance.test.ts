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
