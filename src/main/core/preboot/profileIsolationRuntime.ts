import fs from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

// import { app, session } from 'electron'
import { app } from 'electron'

import { application } from '@application'
import { CHERRY_HOME } from '@main/core/paths/constants'
import {
  createProfilePaths,
  isProfileIsolationEnabled,
  LegacyProfileAdoption,
  ProfileBootJournal,
  ProfilePrebootCoordinator,
  ProfileRegistry,
  ProfileSensitiveDataMigrator,
  // resolveAuthSessionPath,
  resolveProfileRoot,
  SIGNED_OUT_DIGEST,
  verifyCandidateProfile,
  type StartupVerificationResult,
  type ProfileLaunchContext
} from '@main/core/profiles'
import { restoreProfileAuthSession } from '@main/core/profiles'
import { bootConfigService } from '@main/data/bootConfig'
import { OrgCredentialStore } from '@main/enterprise/OrgCredentialStore'
import { createStartupCurrentUserTransport, type ElectronSessionLike } from '@main/enterprise/orgCurrentUserTransport'

import { applyProfileIsolationPaths, lockProfileDataRoot, resolveProfileDataRoot } from './profileIsolationPreboot'
import { getNormalizedExecutablePath } from './userDataLocation'

export function shouldUseProfileIsolation(): boolean {
  return isProfileIsolationEnabled({
    isPackaged: app.isPackaged,
    profileIsolationEnabled: bootConfigService.get('app.profile_isolation_enabled'),
    env: process.env
  })
}

function electronPrebootApi() {
  return {
    setPath: (name: 'userData' | 'sessionData' | 'crashDumps' | 'temp', value: string) => app.setPath(name, value),
    setAppLogsPath: (value: string) => app.setAppLogsPath(value),
    mkdirSync: (value: string, options?: { recursive?: boolean }) => fs.mkdirSync(value, options),
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    freezePathRegistry: () => application.initPathRegistry()
  }
}

export function resolveCurrentProfileDataRoot(legacyRoot: string): string {
  return resolveProfileDataRoot(legacyRoot, getNormalizedExecutablePath(), bootConfigService.get('app.data_root_path'))
}

export function lockCurrentProfileDataRoot(dataRoot: string): boolean {
  return lockProfileDataRoot(dataRoot, electronPrebootApi())
}

export async function initializeLockedProfileIsolation(
  legacyRoot: string,
  dataRoot: string
): Promise<ProfileLaunchContext> {
  const coordinator = new ProfilePrebootCoordinator({
    dataRoot,
    legacyRoot,
    legacyDataExists: async () => fs.existsSync(path.join(legacyRoot, 'Data')),
    cleanupCommittedSource: async (profileRoot) => {
      await rm(path.join(profileRoot, 'userData', 'Sensitive', 'Enterprise', 'org-session.json.quarantine'), {
        force: true
      })
    }
  })
  const context = await coordinator.initialize()
  applyProfileIsolationPaths(context, electronPrebootApi())
  ;(await import('@logger')).loggerService.rebind(path.join(context.profileRoot, 'logs'))
  return context
}

export async function adoptLegacyProfile(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'migration-required' || !context.legacyRoot) {
    throw new Error('Legacy profile adoption requires a migration-required launch')
  }
  await new LegacyProfileAdoption({ legacyRoot: context.legacyRoot, dataRoot: context.dataRoot }).adopt()
}

export async function migrateProfileSensitiveData(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'business') return
  const registry = new ProfileRegistry(path.join(context.dataRoot, 'control', 'profiles.json'))
  const state = await registry.read()
  const profile = state.profiles.find((candidate) => candidate.profileId === context.profileId)
  if (!profile || profile.kind === 'signed-out') {
    throw new Error(`Cannot migrate sensitive data for unverified profile ${context.profileId}`)
  }
  await new ProfileSensitiveDataMigrator({
    cherryHome: CHERRY_HOME,
    legacyUserData: context.legacyRoot
  }).migrate({
    mode: context.mode,
    profile: {
      kind: profile.kind,
      profileId: profile.profileId,
      identityDigest: profile.identityDigest
    },
    userData: application.getPath('app.userdata')
  })
}

export async function markProfileBootSuccessful(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'business') return
  const journal = new ProfileBootJournal(path.join(context.dataRoot, 'control', 'boot-journal.json'))
  await journal.recordSuccess(context.profileId)
}

/**
 * Builds a signed-out launch context from a dataRoot. Kept for tests and the
 * preboot recovery flows; the verifier no longer routes failures here.
 */
export function buildSignedOutLaunchContext(dataRoot: string): ProfileLaunchContext {
  const paths = createProfilePaths(dataRoot)
  return {
    mode: 'signed-out',
    profileId: 'signed-out',
    identityDigest: SIGNED_OUT_DIGEST,
    kind: 'signed-out',
    dataRoot: paths.dataRoot,
    profileRoot: resolveProfileRoot(paths, 'signed-out')
  }
}

/**
 * Fail-closed route for a candidate that cannot be online-verified. Uses a
 * dedicated recovery context at the control plane (not a signed-out profile
 * bound to the candidate business disk), per design §3 / line 179.
 */
export function buildVerificationFailureContext(dataRoot: string): ProfileLaunchContext {
  const paths = createProfilePaths(dataRoot)
  return {
    mode: 'recovery',
    profileId: 'signed-out',
    identityDigest: SIGNED_OUT_DIGEST,
    kind: 'signed-out',
    dataRoot: paths.dataRoot,
    profileRoot: path.join(paths.controlRoot, 'recovery-profile')
  }
}

// Startup gate: before any business service registers, recover the candidate
// session and verify it online via `/api/currentuser`. On failure the result
// routes to a recovery window that defers all state change to transaction+restart.
export async function verifyBusinessCandidate(context: ProfileLaunchContext): Promise<StartupVerificationResult> {
  if (context.mode !== 'business') {
    throw new Error('verifyBusinessCandidate requires a business launch context')
  }
  const credentialStore = new OrgCredentialStore(context.profileRoot)
  try {
    const stored = await credentialStore.load()
    const electronSession =
      stored?.authMode === 'management-cookie'
        ? // ? (session.fromPath(resolveAuthSessionPath(context.profileRoot)) as unknown as ElectronSessionLike)
          ((await restoreProfileAuthSession(context.profileRoot, stored.authOrigin)) as ElectronSessionLike)
        : undefined
    const transport = createStartupCurrentUserTransport(stored, { electronSession })
    return await verifyCandidateProfile({
      context,
      session: stored,
      transport,
      buildFailureContext: buildVerificationFailureContext
    })
  } catch {
    return {
      kind: 'failed',
      reason: 'Candidate credentials or auth session could not be opened securely',
      failureContext: buildVerificationFailureContext(context.dataRoot)
    }
  }
}
