import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * IpcAdapter source-trust gate tests.
 *
 * The adapter bridges Electron IPC to ApiServer; every channel must reject
 * senders that are not the app's own top-level renderer frame BEFORE the
 * request reaches ApiServer (see core/security/validateSender). The pure URL logic is
 * covered in core/security/__tests__/validateSender.test.ts — here we verify the
 * wiring: rejection short-circuits, trusted requests pass through.
 */
import { profileSwitchFence, setProfileLaunchContext, profileBusinessAccessGate } from '@main/core/profiles'
import { IpcChannel } from '@shared/IpcChannel'

import type { ApiServer } from '../../ApiServer'
import { IpcAdapter } from '../IpcAdapter'

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

type IpcHandler = (event: any, payload: any) => Promise<any>

// The unified application mock resolves getPath('app.root') to '/mock/app.root'.
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///mock/app.root/index.html', parent: null }
} as any
const untrustedEvents = {
  webview: {
    sender: { getType: () => 'webview' },
    senderFrame: { url: 'file:///mock/app.root/index.html', parent: null }
  },
  'sub-frame': {
    sender: { getType: () => 'window' },
    senderFrame: { url: 'file:///mock/app.root/index.html', parent: {} }
  },
  'remote origin': {
    sender: { getType: () => 'window' },
    senderFrame: { url: 'https://evil.example.com/', parent: null }
  },
  'missing frame': {
    sender: { getType: () => 'window' },
    senderFrame: null
  }
} as Record<string, any>

describe('IpcAdapter', () => {
  let handleRequest: ReturnType<typeof vi.fn<(...args: any[]) => any>>
  let requestHandler: IpcHandler

  beforeEach(() => {
    profileSwitchFence.resetForTesting()
    vi.mocked(ipcMain.handle).mockClear()
    handleRequest = vi.fn(async (request) => ({
      id: request.id,
      status: 200,
      data: { ok: true },
      metadata: { duration: 1, timestamp: 1 }
    }))
    new IpcAdapter({ handleRequest } as unknown as ApiServer).setup()

    const calls = vi.mocked(ipcMain.handle).mock.calls
    const handlerFor = (channel: string) => calls.find((call) => call[0] === channel)![1] as IpcHandler
    requestHandler = handlerFor(IpcChannel.DataApi_Request)
  })

  afterEach(() => {
    setProfileLaunchContext(undefined)
  })

  function isolatedBusiness() {
    setProfileLaunchContext({
      mode: 'business',
      kind: 'authenticated',
      profileId: 'account',
      identityDigest: 'digest',
      dataRoot: '/data',
      profileRoot: '/data/profiles/account'
    })
  }

  it.each(['GET', 'POST'])('blocks %s before startup verification grants access', async (method) => {
    isolatedBusiness()
    const response = await requestHandler(trustedEvent, { id: 'blocked', method, path: '/topics' })
    expect(response.status).toBe(403)
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it('allows requests after startup verification succeeds', async () => {
    isolatedBusiness()
    profileBusinessAccessGate.recordVerificationSuccess()
    const response = await requestHandler(trustedEvent, { id: 'verified', method: 'GET', path: '/topics' })
    expect(response.status).toBe(200)
    expect(response.data).toEqual({ ok: true })
  })

  it('does not return data if verification fails while a read is in flight', async () => {
    isolatedBusiness()
    profileBusinessAccessGate.recordVerificationSuccess()
    handleRequest.mockImplementation(async () => {
      profileBusinessAccessGate.recordVerificationFailure('offline')
      return { id: 'late', status: 200, data: { private: 'data' } }
    })
    const response = await requestHandler(trustedEvent, { id: 'late', method: 'GET', path: '/topics' })
    expect(response.status).toBe(403)
    expect(response.data).toBeUndefined()
  })

  it('passes a trusted request through to ApiServer', async () => {
    const request = { id: 'req-1', method: 'GET', path: '/topics' }
    const response = await requestHandler(trustedEvent, request)

    expect(handleRequest).toHaveBeenCalledWith(request)
    expect(response).toMatchObject({ id: 'req-1', status: 200, data: { ok: true } })
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s mutations while profile switching', async (method) => {
    profileSwitchFence.beginSwitch('550e8400-e29b-41d4-a716-446655440000')

    const response = await requestHandler(trustedEvent, { id: 'req-write', method, path: '/topics' })

    expect(response.status).toBe(400)
    expect(response.error).toMatchObject({ code: 'INVALID_OPERATION' })
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it('rejects reads during switching and waits for reads already admitted', async () => {
    let finish!: (value: unknown) => void
    handleRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const work = requestHandler(trustedEvent, { id: 'old', method: 'GET', path: '/topics' })
    profileSwitchFence.beginSwitch('logout')
    const late = await requestHandler(trustedEvent, { id: 'late', method: 'GET', path: '/topics' })
    expect(late.status).toBe(400)
    await expect(profileSwitchFence.drainTasks(1)).rejects.toThrow(/in-flight/i)
    finish({ id: 'old', status: 200, data: [] })
    await work
    await profileSwitchFence.drainTasks(1000)
  })

  it('rejects untrusted request senders with 403 before ApiServer is reached', async () => {
    for (const [kind, event] of Object.entries(untrustedEvents)) {
      const response = await requestHandler(event, { id: 'req-x', method: 'POST', path: '/topics' })

      expect(response.status, `${kind} sender must get 403`).toBe(403)
      expect(response.id).toBe('req-x')
      expect(response.error).toMatchObject({ code: 'PERMISSION_DENIED', status: 403 })
    }
    expect(handleRequest).not.toHaveBeenCalled()
  })
})
