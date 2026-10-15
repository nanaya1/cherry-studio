import path from 'node:path'

import type { ProfileLaunchContext } from '@main/core/profiles'

export function deriveProfileDataRoot(legacyUserData: string): string {
  const normalized = path.normalize(legacyUserData)
  return path.join(path.dirname(normalized), `${path.basename(normalized)}.profiles-v2`)
}

export function resolveProfileDataRoot(
  legacyUserData: string,
  executablePath: string,
  configuredRoots: Record<string, string>
): string {
  const configured = configuredRoots[executablePath]
  return configured ? path.resolve(configured) : deriveProfileDataRoot(legacyUserData)
}

export interface ProfileIsolationElectronApi {
  setPath(name: 'userData' | 'sessionData' | 'crashDumps' | 'temp', value: string): void
  setAppLogsPath(value: string): void
  mkdirSync(value: string, options?: { recursive?: boolean }): void
  requestSingleInstanceLock(): boolean
  rebindLogger?(logsDir: string): void
  freezePathRegistry(): void
}

export function lockProfileDataRoot(dataRoot: string, electron: ProfileIsolationElectronApi): boolean {
  const instanceRoot = path.join(dataRoot, 'control', 'electron-instance')
  electron.mkdirSync(instanceRoot, { recursive: true })
  electron.setPath('userData', instanceRoot)
  return electron.requestSingleInstanceLock()
}

export function applyProfileIsolationPaths(
  context: ProfileLaunchContext,
  electron: ProfileIsolationElectronApi
): void {
  const profileDirectories = ['userData', 'sessionData', 'logs', 'crashDumps', 'temp'] as const
  for (const directory of profileDirectories) {
    electron.mkdirSync(path.join(context.profileRoot, directory), { recursive: true })
  }

  electron.setPath('userData', path.join(context.profileRoot, 'userData'))
  electron.setPath('sessionData', path.join(context.profileRoot, 'sessionData'))
  electron.setAppLogsPath(path.join(context.profileRoot, 'logs'))
  electron.setPath('crashDumps', path.join(context.profileRoot, 'crashDumps'))
  electron.setPath('temp', path.join(context.profileRoot, 'temp'))
  electron.rebindLogger?.(path.join(context.profileRoot, 'logs'))
  electron.freezePathRegistry()
}

export async function runProfileIsolationPreboot(
  dataRoot: string,
  initializeProfile: () => Promise<ProfileLaunchContext>,
  electron: ProfileIsolationElectronApi
): Promise<ProfileLaunchContext | undefined> {
  if (!lockProfileDataRoot(dataRoot, electron)) return undefined

  const context = await initializeProfile()
  applyProfileIsolationPaths(context, electron)
  return context
}
