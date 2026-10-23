/* eslint-disable lifecycle/no-direct-quit -- Standalone auth worker has no application lifecycle. */
import fs from 'node:fs'
import path from 'node:path'

import { app, session } from 'electron'

import type { AuthSessionOperation } from './AuthSessionProcess'

export function startAuthWorker(profileRoot: string): void {
  if (!process.send || !path.isAbsolute(profileRoot)) {
    app.exit(1)
    return
  }
  const storage = path.join(profileRoot, 'Session', 'auth')
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 })
  app.setPath('userData', storage)
  app.setPath('sessionData', storage)
  const timer = setTimeout(() => app.exit(1), 20_000)
  process.once('disconnect', () => app.exit(1))
  process.once('message', async (request: AuthSessionOperation) => {
    try {
      if (request.profileRoot !== profileRoot || !['read', 'replace'].includes(request.operation)) throw new Error()
      const origin = new URL(request.baseUrl)
      if (!['http:', 'https:'].includes(origin.protocol)) throw new Error()
      await app.whenReady()
      // Cookie storage worker runs as a separate Electron process; keep it out of the macOS Dock.
      if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
      const target = session.defaultSession
      if (request.operation === 'replace') {
        const previous = await target.cookies.get({ url: request.baseUrl, name: 'sid' })
        for (const cookie of previous) await target.cookies.remove(new URL(cookie.path || '/', origin).href, 'sid')
        for (const cookie of request.cookies ?? []) {
          if (cookie.name !== 'sid' || new URL(cookie.url).origin !== origin.origin) throw new Error()
          await target.cookies.set(cookie)
        }
        await target.cookies.flushStore()
      }
      const result = await target.cookies.get({ url: request.baseUrl, name: 'sid' })
      clearTimeout(timer)
      process.send!({ ok: true, result }, undefined, undefined, () => app.quit())
    } catch {
      clearTimeout(timer)
      process.send!({ ok: false }, undefined, undefined, () => app.exit(1))
    }
  })
}
