import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, dialog, type MessageBoxOptions, safeStorage } from 'electron'

import { application } from '@application'
import { type PersonalProfile, resolvePersonalProfileLocation } from '@main/core/preboot/personalProfileLocation'
import {
  readPersonalProfileSelection,
  writePersonalProfileSelection
} from '@main/core/preboot/personalProfileSelection'
import { PersonalProfileSwitch } from '@main/core/preboot/personalProfileSwitch'
import { getPersonalDataRoot } from '@main/core/preboot/userDataLocation'

import { loginPersonalAccount, readPersonalAccountData } from './personalAccountLogin'

let busy = false
let stoppedRuntime = false

function credentialPath(root: string, profile: PersonalProfile): string {
  return path.join(resolvePersonalProfileLocation(root, profile), 'personal-session.enc')
}

function personalAccountEndpoint(): string {
  const endpoint = new URL(import.meta.env.MAIN_VITE_ORG_SERVER_BASE_URL?.trim() ?? '')
  const isInternalHttp =
    endpoint.protocol === 'http:' &&
    (endpoint.hostname === '127.0.0.1' || endpoint.origin === 'http://10.88.40.144:8082')
  if (endpoint.protocol !== 'https:' && !isInternalHttp) {
    throw new Error('Personal account authentication requires HTTPS')
  }
  return endpoint.origin
}

export async function getPersonalAccountDetails(): Promise<{ username: string; displayName: string } | null> {
  const root = getPersonalDataRoot()
  const profile = readPersonalProfileSelection(root)
  if (profile.kind !== 'account' || stoppedRuntime || !safeStorage.isEncryptionAvailable()) return null

  try {
    const token = safeStorage.decryptString(readFileSync(credentialPath(root, profile)))
    const account = (await readPersonalAccountData(
      await fetch(`${personalAccountEndpoint()}/api/v1/auth/me`, {
        redirect: 'error',
        headers: { token },
        signal: AbortSignal.timeout(5_000)
      })
    )) as { serverInstanceId?: unknown; id?: unknown; username?: unknown; showName?: unknown } | null
    if (
      stoppedRuntime ||
      account?.serverInstanceId !== profile.serverInstanceId ||
      String(account.id) !== profile.userId ||
      typeof account.username !== 'string'
    ) {
      return null
    }
    const username = account.username.trim()
    return username
      ? { username, displayName: (typeof account.showName === 'string' && account.showName.trim()) || username }
      : null
  } catch {
    return null
  }
}

export async function changePersonalAccount(
  input: Parameters<typeof loginPersonalAccount>[1] | null,
  confirmation: { title: string; message: string; cancel: string; proceed: string }
): Promise<'updated' | 'cancelled' | 'busy' | 'relaunching'> {
  if (busy || stoppedRuntime) return 'busy'
  busy = true
  try {
    const root = getPersonalDataRoot()
    const previous = readPersonalProfileSelection(root)
    let target: PersonalProfile = { kind: 'guest' }
    let credential: Buffer | undefined
    if (input) {
      const baseUrl = personalAccountEndpoint()
      const key = import.meta.env.MAIN_VITE_ORG_RSA_PUBLIC_KEY?.trim()
      if (!baseUrl || !key || !safeStorage.isEncryptionAvailable()) {
        throw new Error('Personal account authentication is unavailable')
      }
      const publicKey = key.startsWith('-----BEGIN')
        ? key
        : `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`
      const session = await loginPersonalAccount({ baseUrl, publicKey, fetch }, input, AbortSignal.timeout(30_000))
      target = { kind: 'account', serverInstanceId: session.serverInstanceId, userId: session.userId }
      credential = safeStorage.encryptString(session.accessToken)
    }

    const saveCredential = () => {
      if (!credential) return
      const file = credentialPath(root, target)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, credential, { mode: 0o600 })
    }
    if (resolvePersonalProfileLocation(root, previous) === resolvePersonalProfileLocation(root, target)) {
      saveCredential()
      return 'updated'
    }

    const coordinator = new PersonalProfileSwitch({
      confirmSwitch: async () => {
        const options: MessageBoxOptions = {
          type: 'question',
          title: confirmation.title,
          message: confirmation.message,
          detail: app.isPackaged ? undefined : 'The app will exit. Run pnpm debug again to reopen it.',
          buttons: [confirmation.cancel, confirmation.proceed],
          defaultId: 0,
          cancelId: 0
        }
        const parent = BrowserWindow.getFocusedWindow()
        const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
        return response === 1
      },
      stopCurrentProfile: () => {
        stoppedRuntime = true
        return application.preparePersonalProfileSwitch()
      },
      commitSelection: (profile) => {
        saveCredential()
        if (profile.kind === 'guest' && previous.kind === 'account') {
          rmSync(credentialPath(root, previous), { force: true })
        }
        writePersonalProfileSelection(root, profile)
      },
      relaunch: () => application.relaunchAfterPersonalProfileSwitch()
    })
    return await coordinator.switchTo(target)
  } finally {
    busy = false
  }
}
