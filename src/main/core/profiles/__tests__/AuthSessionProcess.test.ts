import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/application' } }))

import { runAuthSessionOperation } from '../AuthSessionProcess'

// Catch accepting a child reply before its cookie database has been closed.
describe('auth session process completion', () => {
  it('launches an Electron application instead of the Electron Node-only fork mode', async () => {
    const events: Record<string, (...args: any[]) => void> = {}
    spawnMock.mockImplementationOnce(() => {
      const child = {
        on: (name: string, handler: (...args: any[]) => void) => {
          events[name] = handler
          return child
        },
        send: () =>
          queueMicrotask(() => {
            events.message({ ok: true, result: [] })
            events.exit(0, null)
          }),
        kill: vi.fn()
      }
      return child
    })
    await expect(
      runAuthSessionOperation({ operation: 'read', profileRoot: '/target', baseUrl: 'https://example.test' })
    ).resolves.toEqual([])
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/application', '--profile-auth-worker', '/target'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    )
    const options = spawnMock.mock.calls[0][2]
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('rejects a failed process even after a successful reply', async () => {
    const events: Record<string, (...args: any[]) => void> = {}
    const child = {
      on: (name: string, handler: (...args: any[]) => void) => {
        events[name] = handler
        return child
      },
      send: () => {
        queueMicrotask(() => {
          events.message({ ok: true, result: [] })
          events.exit(1, null)
        })
      },
      kill: () => undefined
    }
    await expect(
      runAuthSessionOperation(
        { operation: 'read', profileRoot: '/target', baseUrl: 'https://example.test' },
        () => child as any
      )
    ).rejects.toThrow(/process/)
  })

  it('returns a result only after clean exit', async () => {
    const events: Record<string, (...args: any[]) => void> = {}
    let resolved = false
    const child = {
      on: (name: string, handler: (...args: any[]) => void) => {
        events[name] = handler
        return child
      },
      send: () => {
        queueMicrotask(() => {
          events.message({ ok: true, result: [{ name: 'sid' }] })
          queueMicrotask(() => {
            expect(resolved).toBe(false)
            events.exit(0, null)
          })
        })
      },
      kill: () => undefined
    }
    const result = await runAuthSessionOperation(
      { operation: 'read', profileRoot: '/target', baseUrl: 'https://example.test' },
      () => child as any
    )
    resolved = true
    expect(result).toEqual([{ name: 'sid' }])
  })
})
