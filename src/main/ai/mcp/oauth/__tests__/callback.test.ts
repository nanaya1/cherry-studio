import { EventEmitter } from 'events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CallBackServer } from '../callback'

describe('CallBackServer.waitForAuthCode', () => {
  let events: EventEmitter
  let server: CallBackServer

  beforeEach(() => {
    vi.useFakeTimers()
    events = new EventEmitter()
    // Port 0 lets the OS pick a free ephemeral port, so the real HTTP server in
    // the constructor never collides with another test or a running app.
    server = new CallBackServer({ port: 0, path: '/oauth/callback', events })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.close()
  })

  it('resolves with the code when auth-code-received fires before the timeout', async () => {
    const promise = server.waitForAuthCode(1000)

    events.emit('auth-code-received', 'the-auth-code')

    await expect(promise).resolves.toBe('the-auth-code')
  })

  it('rejects when no auth-code-received fires within the timeout', async () => {
    const promise = server.waitForAuthCode(1000)
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for OAuth authorization code/)

    await vi.advanceTimersByTimeAsync(1000)

    await assertion
  })

  it('does not reject after resolving (timer is cleared on success)', async () => {
    const promise = server.waitForAuthCode(1000)
    events.emit('auth-code-received', 'first-code')

    await expect(promise).resolves.toBe('first-code')

    // Advancing past the original timeout must not trigger any late rejection,
    // and the listener must have been removed (no leak for a second emit).
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.listenerCount('auth-code-received')).toBe(0)
  })

  it('retains a callback received before the authorization-code waiter is attached', async () => {
    vi.useRealTimers()
    const listener = await server.getServer
    const { port } = listener.address() as AddressInfo
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/oauth/callback?code=early-code`, (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        })
        .on('error', reject)
    })

    expect(status).toBe(200)
    await expect(server.waitForAuthCode(100)).resolves.toBe('early-code')
  })

  it('rejects a callback with a mismatched OAuth state', async () => {
    vi.useRealTimers()
    const guarded = new CallBackServer({
      port: 0,
      path: '/oauth/callback',
      events: new EventEmitter(),
      expectedState: 'expected-state'
    })
    try {
      const listener = await guarded.getServer
      const { port } = listener.address() as AddressInfo
      const pending = guarded.waitForAuthCode(1000)
      const assertion = expect(pending).rejects.toThrow('OAuth callback state mismatch')
      const status = await new Promise<number | undefined>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/oauth/callback?code=code&state=wrong-state`, (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode))
          })
          .on('error', reject)
      })

      expect(status).toBe(400)
      await assertion
    } finally {
      await guarded.close()
    }
  })

  it.each([
    ['code=accepted-code&state=expected-state', 200, 'accepted-code'],
    ['error=access_denied&state=expected-state', 400, 'access_denied'],
    ['code=rejected-code&state=wrong-state', 400, 'OAuth callback state mismatch']
  ] as const)('retains an early authorization outcome: %s', async (query, expectedStatus, outcome) => {
    vi.useRealTimers()
    const guarded = new CallBackServer({
      port: 0,
      path: '/oauth/callback',
      events: new EventEmitter(),
      expectedState: 'expected-state'
    })
    try {
      const listener = await guarded.getServer
      const { port } = listener.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?${query}`)
      await response.text()
      expect(response.status).toBe(expectedStatus)
      if (expectedStatus === 200) {
        await expect(guarded.waitForAuthCode(1000)).resolves.toBe(outcome)
      } else {
        await expect(guarded.waitForAuthCode(1000)).rejects.toThrow(outcome)
      }
    } finally {
      await guarded.close()
    }
  })

  it('cancels authorization waiting without retaining listeners or timers', async () => {
    const controller = new AbortController()
    const pending = server.waitForAuthCode(300_000, controller.signal)
    const assertion = expect(pending).rejects.toThrow('logout')
    controller.abort(new Error('logout'))
    await assertion
    expect(events.listenerCount('auth-code-received')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(server.waitForAuthCode(300_000, controller.signal)).rejects.toThrow('logout')
  })

  it('waits for the real callback listener to close', async () => {
    const listener = await server.getServer
    await server.close()
    expect(listener.listening).toBe(false)
    expect(listener.address()).toBeNull()
  })

  it('close resolves when listen failed so a bind failure can reject first', async () => {
    const failed = new CallBackServer({ port: 99999, path: '/oauth/callback', events: new EventEmitter() })
    await expect(failed.getServer).rejects.toThrow()
    await expect(failed.close()).resolves.toBeUndefined()
  })
})
