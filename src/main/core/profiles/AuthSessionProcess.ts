// import { fork, type ChildProcess } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'

import { app, type Cookie, type CookiesSetDetails } from 'electron'

export interface AuthSessionOperation {
  operation: 'read' | 'replace'
  profileRoot: string
  baseUrl: string
  cookies?: CookiesSetDetails[]
}

export function runAuthSessionOperation(
  request: AuthSessionOperation,
  launch: () => ChildProcess = () =>
    // Electron's fork forces Node mode; the worker needs Chromium's persistent session.
    // fork(app.getAppPath(), ['--profile-auth-worker', request.profileRoot], { execPath: process.execPath, execArgv: [],
    spawn(process.execPath, [app.getAppPath(), '--profile-auth-worker', request.profileRoot], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
): Promise<Cookie[]> {
  return new Promise((resolve, reject) => {
    const child = launch()
    let reply: { ok: boolean; result?: Cookie[] } | undefined
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Auth session process timed out'))
    }, 20_000)
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'ok' in message) reply = message as typeof reply
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error('Auth session process could not start'))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0 || !reply?.ok || !Array.isArray(reply.result)) {
        // reject(new Error('Auth session process failed'))
        reject(
          new Error(
            `Auth session process failed (${request.operation}; exit=${code}; signal=${signal ?? 'none'}; reply=${reply?.ok ?? 'missing'})`
          )
        )
      } else resolve(reply.result)
    })
    child.send(request, (error) => {
      if (!error) return
      clearTimeout(timer)
      child.kill()
      reject(new Error('Auth session process communication failed'))
    })
  })
}
