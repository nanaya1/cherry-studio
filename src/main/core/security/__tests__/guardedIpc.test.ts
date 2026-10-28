import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { IpcChannel } from '@shared/IpcChannel'

import { profileSwitchFence } from '../../profiles/SwitchFence'
import { assertTrustedSender, handleGuarded } from '../guardedIpc'

const APP_ROOT = resolve(application.getPath('app.root'))
const indexUrl = pathToFileURL(join(APP_ROOT, 'index.html')).href

// `parent` defaults to null (a top-level frame); pass a non-null frame to model a sub-frame.
const evt = (type: string, url: string | null, parent: unknown = null): IpcMainInvokeEvent =>
  ({
    sender: { getType: () => type },
    senderFrame: url === null ? null : { url, parent }
  }) as unknown as IpcMainInvokeEvent

describe('assertTrustedSender', () => {
  it('passes a top-level frame on an app page', () => {
    expect(() => assertTrustedSender(evt('window', indexUrl), 'File_Read', APP_ROOT)).not.toThrow()
  })

  it('rejects a webview guest with FORBIDDEN_SENDER', () => {
    const rejection = () => assertTrustedSender(evt('webview', indexUrl), 'File_Read', APP_ROOT)
    expect(rejection).toThrow(IpcError)
    expect(rejection).toThrow('untrusted sender')
  })

  it('rejects a sub-frame even when its url is an app page', () => {
    const parentFrame = { url: indexUrl }
    expect(() => assertTrustedSender(evt('window', indexUrl, parentFrame), 'File_Read', APP_ROOT)).toThrow(
      'untrusted sender'
    )
  })

  it('rejects a foreign file: page opened in an app window', () => {
    const foreignUrl = pathToFileURL(join(tmpdir(), 'evil.html')).href
    expect(() => assertTrustedSender(evt('window', foreignUrl), 'File_Read', APP_ROOT)).toThrow('untrusted sender')
  })
})

describe('handleGuarded', () => {
  afterEach(() => profileSwitchFence.resetForTesting())

  it('keeps an admitted manual backup pending until it finishes and rejects new work during switching', async () => {
    vi.mocked(ipcMain.handle).mockClear()
    let finish!: () => void
    handleGuarded(
      'Backup_Backup',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const wrapped = vi.mocked(ipcMain.handle).mock.calls[0][1]
    const work = wrapped(evt('window', indexUrl))
    profileSwitchFence.beginSwitch('logout')
    expect(() => wrapped(evt('window', indexUrl))).toThrow(/profile switch/i)
    await expect(profileSwitchFence.drainTasks(1)).rejects.toThrow(/in-flight/i)
    finish()
    await work
    await profileSwitchFence.drainTasks(1000)
  })

  it('keeps restart recovery available after a failed switch', () => {
    vi.mocked(ipcMain.handle).mockClear()
    handleGuarded(IpcChannel.Application_Relaunch, () => 'restarting')
    profileSwitchFence.beginSwitch('logout')
    profileSwitchFence.markTeardownFailed('busy')
    const wrapped = vi.mocked(ipcMain.handle).mock.calls[0][1]
    expect(wrapped(evt('window', indexUrl))).toBe('restarting')
  })

  it('registers through ipcMain.handle and gates before the handler runs', () => {
    const handle = vi.mocked(ipcMain.handle)
    handle.mockClear()
    const handler = vi.fn(() => 'ok')

    handleGuarded('File_Read', handler)
    expect(handle).toHaveBeenCalledOnce()
    const [, wrapped] = handle.mock.calls[0]

    // Trusted sender: args pass through and the handler result returns.
    const event = evt('window', indexUrl)
    expect(wrapped(event, 'a', 1)).toBe('ok')
    expect(handler).toHaveBeenCalledWith(event, 'a', 1)

    // Untrusted sender: rejects before the handler is reached.
    expect(() => wrapped(evt('webview', indexUrl), 'a')).toThrow(IpcError)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
