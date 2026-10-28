import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as LifecycleModule from '@main/core/lifecycle'

/**
 * OvmsManager owns processes it starts (ovms.exe via run.bat, ovdnd.exe downloads).
 * These tests pin the contract that stop paths never scan-kill external instances,
 * that only owned handles are terminated, and that onStop propagates a non-clean
 * failure. Windows process-tree behavior (Stop-Process / PID reuse) is exercised
 * only through mocked PowerShell output — see report for the untested-on-Windows note.
 */

const h = vi.hoisted(() => {
  const execAsyncCalls: Array<{ command: string; options?: any }> = []
  const getProcessSeen = new Map<number, number>()
  const state = {
    failPowerShell: false,
    runBatPid: 1234,
    // parent pid -> child pids, used to simulate a process tree for terminalProcess recursion.
    childrenOf: new Map<number, number[]>(),
    // pids whose Stop-Process should fail, to exercise failure propagation.
    failKillPids: new Set<number>()
  }
  const makeChild = (pid: number) => ({
    pid,
    killed: false,
    exitCode: null,
    kill: vi.fn(() => true),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  })
  const execMock = vi.fn((command: any, ...rest: any[]) => {
    const cb = rest.find((a) => typeof a === 'function')
    const options = rest.find((a) => a && typeof a === 'object' && !Array.isArray(a))
    // PowerShell calls (used by stop/kill paths) -> drive terminalProcess.
    if (typeof command === 'string' && command.startsWith('powershell')) {
      execAsyncCalls.push({ command, options })
      const respond = (err: any, out = '') => {
        if (cb) void Promise.resolve().then(() => cb(err, { stdout: out, stderr: '' }))
      }
      if (state.failPowerShell) {
        respond(new Error('powershell failed'))
        return undefined
      }
      // Child-process enumeration: Get-WmiObject ... ParentProcessId -eq <pid>
      const wmi = command.match(/ParentProcessId -eq (\d+)/)
      if (wmi) {
        const parent = Number(wmi[1])
        const kids = state.childrenOf.get(parent) ?? []
        const out = kids.length ? JSON.stringify(kids.map((p) => ({ ProcessId: p }))) : ''
        respond(null, out)
        return undefined
      }
      // Kill command: Stop-Process -Id <pid>
      if (command.includes('Stop-Process')) {
        const m = command.match(/Stop-Process -Id (\d+)/)
        const pid = m ? Number(m[1]) : -1
        if (state.failKillPids.has(pid)) {
          respond(new Error(`stop failed ${pid}`))
          return undefined
        }
        respond(null, '')
        return undefined
      }
      // Liveness probe / exit-confirm loop: Get-Process -Id <pid>
      const m = command.match(/Get-Process -Id (\d+)/)
      if (m) {
        const pid = Number(m[1])
        const seen = getProcessSeen.get(pid) ?? 0
        getProcessSeen.set(pid, seen + 1)
        // First liveness probe reports alive; later probes (the exit-confirm loop) report gone.
        const stdout = seen === 0 ? JSON.stringify({ Id: pid }) : ''
        respond(null, stdout)
        return undefined
      }
      respond(null, '')
      return undefined
    }
    // run.bat spawn -> return the owned child handle and keep it alive (no exit callback).
    return makeChild(state.runBatPid)
  })
  // execFile callback form: fire success asynchronously so addModel's Promise resolves and
  // the owned handle (downloadChild) is set/cleared in the right order.
  const execFileMock = vi.fn((_command: any, _args: any, _options: any, callback?: any) => {
    const cb = typeof _options === 'function' ? _options : callback
    const child = makeChild(9999)
    if (cb) void Promise.resolve().then(() => cb(null, '', ''))
    return child
  })
  const getPathMock = vi.fn((_ns: string, file?: string) => (file ? `/mock/ovms/${file}` : '/mock/ovms'))
  return { execAsyncCalls, getProcessSeen, state, makeChild, execMock, execFileMock, getPathMock }
})

vi.mock('node:child_process', () => ({ exec: h.execMock, execFile: h.execFileMock }))

vi.mock('fs-extra', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  writeJson: vi.fn().mockResolvedValue(undefined),
  readJson: vi.fn().mockResolvedValue({ mediapipe_config_list: [] }),
  readdir: vi.fn().mockResolvedValue([]),
  lstatSync: vi.fn(() => ({ isDirectory: () => false })),
  remove: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@application', () => ({ application: { getPath: h.getPathMock } }))

vi.mock('@main/core/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof LifecycleModule>()
  class MockBaseService {
    protected readonly _disposables: Array<{ dispose: () => void } | (() => void)> = []
    protected registerDisposable<T extends { dispose: () => void } | (() => void)>(d: T): T {
      this._disposables.push(d)
      return d
    }
  }
  return { ...actual, BaseService: MockBaseService }
})

const { OvmsManager } = await import('../OvmsManager')

const fsMock = vi.mocked(await import('fs-extra'))

beforeEach(() => {
  h.execAsyncCalls.length = 0
  h.getProcessSeen.clear()
  h.state.failPowerShell = false
  h.state.runBatPid = 1234
  h.state.childrenOf.clear()
  h.state.failKillPids.clear()
  vi.clearAllMocks()
  // pathExists defaults to true so runOvms reaches the exec spawn.
  fsMock.pathExists.mockImplementation(async () => true)
})

describe('OvmsManager process ownership', () => {
  it('runOvms records the spawned child as the owned process to manage', async () => {
    const mgr = new OvmsManager()
    const result = await mgr.runOvms()
    expect(result.success).toBe(true)
    const ovms = (mgr as any).ovms
    expect(ovms).not.toBeNull()
    expect(ovms.pid).toBe(1234)
    expect((mgr as any).ovmsChild).toBe(h.execMock.mock.results[0].value)
  })

  it('stopOvms terminates only the owned process tree (no global scan) and bounds PowerShell', async () => {
    const mgr = new OvmsManager()
    await mgr.runOvms()
    h.execAsyncCalls.length = 0
    const result = await mgr.stopOvms()
    expect(result.success).toBe(true)
    expect((mgr as any).ovms).toBeNull()
    // Killed the owned pid specifically, and never matched ovms.exe globally.
    expect(h.execAsyncCalls.some((c) => c.command.includes('Stop-Process -Id 1234'))).toBe(true)
    expect(h.execAsyncCalls.some((c) => c.command.includes('ovms.exe'))).toBe(false)
    // Every PowerShell invocation is bounded by a timeout.
    expect(h.execAsyncCalls.every((c) => c.options && c.options.timeout === 10000)).toBe(true)
  })

  it('stopOvms is a no-op when no process is owned (does not kill external instances)', async () => {
    const mgr = new OvmsManager()
    const result = await mgr.stopOvms()
    expect(result.success).toBe(true)
    expect(h.execAsyncCalls.length).toBe(0)
  })

  it('initializeOvms never adopts a scanned external ovms.exe as owned', async () => {
    const mgr = new OvmsManager()
    const ok = await mgr.initializeOvms()
    expect(ok).toBe(false)
    expect((mgr as any).ovms).toBeNull()
    // The old code ran `Get-Process -Name "ovms"`; the new code issues no scan at all.
    expect(h.execAsyncCalls.length).toBe(0)
  })

  it('initializeOvms reports true only for a live owned process and clears it once exited', async () => {
    const mgr = new OvmsManager()
    const child = h.makeChild(1234)
    ;(mgr as any).ovms = { pid: 1234, path: '/mock/ovms/run.bat', workingDirectory: '/mock/ovms' }
    ;(mgr as any).ovmsChild = child
    expect(await mgr.initializeOvms()).toBe(true)
    child.killed = true
    expect(await mgr.initializeOvms()).toBe(false)
    expect((mgr as any).ovms).toBeNull()
  })

  it('stopAddModel terminates only the owned download handle (no global scan of ovdnd)', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(9999)
    h.execAsyncCalls.length = 0
    const result = await mgr.stopAddModel()
    expect(result.success).toBe(true)
    expect((mgr as any).downloadChild).toBeNull()
    expect(h.execAsyncCalls.some((c) => c.command.includes('Stop-Process -Id 9999'))).toBe(true)
    expect(h.execAsyncCalls.some((c) => c.command.toLowerCase().includes('ovdnd'))).toBe(false)
  })

  it('stopAddModel is a no-op when no download is owned (does not kill external downloads)', async () => {
    const mgr = new OvmsManager()
    const result = await mgr.stopAddModel()
    expect(result.success).toBe(true)
    expect(h.execAsyncCalls.length).toBe(0)
  })
})

describe('OvmsManager non-clean shutdown', () => {
  it('onStop propagates a failed stop as a non-clean shutdown', async () => {
    const mgr = new OvmsManager()
    await mgr.runOvms()
    h.state.failPowerShell = true
    await expect((mgr as any).onStop()).rejects.toThrow()
  })

  it('onStop resolves cleanly when no process is owned', async () => {
    const mgr = new OvmsManager()
    await expect((mgr as any).onStop()).resolves.toBeUndefined()
  })
})

describe('OvmsManager stop safety', () => {
  it('stopOvms retains the owned handle when the stop is not clean (does not clear on failure)', async () => {
    const mgr = new OvmsManager()
    await mgr.runOvms()
    h.state.failPowerShell = true
    const result = await mgr.stopOvms()
    expect(result.success).toBe(false)
    // The owned references must NOT be cleared on a failed stop.
    expect((mgr as any).ovms).not.toBeNull()
    expect((mgr as any).ovmsChild).not.toBeNull()
  })

  it('stopAddModel retains the owned handle on failure', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(8888)
    h.state.failPowerShell = true
    const result = await mgr.stopAddModel()
    expect(result.success).toBe(false)
    expect((mgr as any).downloadChild).not.toBeNull()
  })

  it('stopAddModel never issues kill -1 and fails on an invalid child pid', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(-1)
    h.execAsyncCalls.length = 0
    const result = await mgr.stopAddModel()
    expect(result.success).toBe(false)
    // A pid of -1 must never reach Stop-Process (that would target the whole session).
    expect(h.execAsyncCalls.some((c) => c.command.includes('Stop-Process -Id -1'))).toBe(false)
    // And the owned handle is retained because the stop failed.
    expect((mgr as any).downloadChild).not.toBeNull()
  })

  it('terminalProcess propagates a child termination failure to the parent result', async () => {
    const mgr = new OvmsManager()
    // Parent 100 owns child 200; killing 200 fails.
    h.state.childrenOf.set(100, [200])
    h.state.failKillPids.add(200)
    const result = await (mgr as any).terminalProcess(100)
    expect(result.success).toBe(false)
    // The child kill was still attempted.
    expect(h.execAsyncCalls.some((c) => c.command.includes('Stop-Process -Id 200'))).toBe(true)
  })

  it('terminalProcess refuses an invalid pid outright', async () => {
    const mgr = new OvmsManager()
    h.execAsyncCalls.length = 0
    const result = await (mgr as any).terminalProcess(-1)
    expect(result.success).toBe(false)
    expect(h.execAsyncCalls.length).toBe(0)
  })

  it('stopAddModel stops the owned download and clears the handle on success', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(7777)
    h.execAsyncCalls.length = 0
    const result = await mgr.stopAddModel()
    expect(result.success).toBe(true)
    expect((mgr as any).downloadChild).toBeNull()
    expect(h.execAsyncCalls.some((c) => c.command.includes('Stop-Process -Id 7777'))).toBe(true)
  })
})

describe('OvmsManager lifecycle guards', () => {
  it('onStop also stops an owned download and then forbids restarts', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(5555)
    await (mgr as any).onStop()
    expect((mgr as any).downloadChild).toBeNull()
    expect((mgr as any).stopped).toBe(true)
    // After shutdown, runOvms/addModel must refuse to start a new owned process.
    expect((await mgr.runOvms()).success).toBe(false)
    expect((mgr as any).ovms).toBeNull()
    expect((await mgr.addModel('m', 'id', 'src')).success).toBe(false)
    expect(h.execFileMock).not.toHaveBeenCalled()
  })
})

describe('OvmsManager handle reuse / double-start', () => {
  it('runOvms reuses the existing owned handle instead of overwriting it', async () => {
    const mgr = new OvmsManager()
    await mgr.runOvms()
    const first = (mgr as any).ovms
    const firstChild = (mgr as any).ovmsChild
    const spawnCallsBefore = h.execMock.mock.calls.length
    const result = await mgr.runOvms()
    expect(result.success).toBe(true)
    // Same owned object/child — a second start did not orphan the first tree.
    expect((mgr as any).ovms).toBe(first)
    expect((mgr as any).ovmsChild).toBe(firstChild)
    // No second spawn happened.
    expect(h.execMock.mock.calls.length).toBe(spawnCallsBefore)
  })

  it('addModel refuses a second download while one is already in progress', async () => {
    const mgr = new OvmsManager()
    ;(mgr as any).downloadChild = h.makeChild(9999)
    const result = await mgr.addModel('m', 'id', 'src')
    expect(result.success).toBe(false)
    expect(h.execFileMock).not.toHaveBeenCalled()
  })
})
