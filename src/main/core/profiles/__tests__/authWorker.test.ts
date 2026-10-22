import { describe, expect, it, vi } from 'vitest'

const { app, session } = vi.hoisted(() => ({
  app: {
    exit: vi.fn(),
    quit: vi.fn(),
    setActivationPolicy: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined)
  },
  session: {
    defaultSession: {
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        flushStore: vi.fn()
      }
    }
  }
}))

vi.mock('electron', () => ({ app, session }))

import { startAuthWorker } from '../authWorker'

describe('auth worker macOS application identity', () => {
  it('sets the background policy only after Electron is ready', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const originalSend = process.send
    const send = vi.fn((_message: unknown, _sendHandle: unknown, _options: unknown, callback: () => void) => callback())
    Object.defineProperty(process, 'send', { configurable: true, value: send })

    try {
      startAuthWorker('/tmp/profile')
      expect(app.setActivationPolicy).not.toHaveBeenCalled()

      // @types/node@24 的 process.emit('message') 重载要求显式传第二个 sendHandle 参数（可为 undefined）
      // process.emit('message', { operation: 'read', profileRoot: '/tmp/profile', baseUrl: 'https://example.test' })
      process.emit(
        'message',
        { operation: 'read', profileRoot: '/tmp/profile', baseUrl: 'https://example.test' },
        undefined
      )
      await vi.waitFor(() => expect(app.setActivationPolicy).toHaveBeenCalledWith('prohibited'))
      expect(app.whenReady).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith({ ok: true, result: [] }, undefined, undefined, expect.any(Function))
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      Object.defineProperty(process, 'send', { configurable: true, value: originalSend })
    }
  })
})
