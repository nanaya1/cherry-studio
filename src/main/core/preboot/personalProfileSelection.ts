import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type PersonalProfile, resolvePersonalProfileLocation } from './personalProfileLocation'

function selectionPath(dataRoot: string): string {
  return path.join(resolvePersonalProfileLocation(dataRoot, { kind: 'guest' }), 'personal-profile.json')
}

export function readPersonalProfileSelection(dataRoot: string): PersonalProfile {
  let contents: string
  try {
    contents = readFileSync(selectionPath(dataRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'guest' }
    throw error
  }

  const record = JSON.parse(contents)
  if (record?.version === 1 && record.kind === 'guest') return { kind: 'guest' }
  if (
    record?.version !== 1 ||
    record.kind !== 'account' ||
    typeof record.serverInstanceId !== 'string' ||
    typeof record.userId !== 'string'
  ) {
    throw new Error('Invalid personal profile selection')
  }
  const profile: PersonalProfile = {
    kind: 'account',
    serverInstanceId: record.serverInstanceId,
    userId: record.userId,
    ...(typeof record.username === 'string' && record.username.trim() && { username: record.username.trim() }),
    ...(typeof record.displayName === 'string' &&
      record.displayName.trim() && { displayName: record.displayName.trim() })
  }
  resolvePersonalProfileLocation(dataRoot, profile)
  return profile
}

export function writePersonalProfileSelection(dataRoot: string, profile: PersonalProfile): void {
  resolvePersonalProfileLocation(dataRoot, profile)
  const target = selectionPath(dataRoot)
  const temporary = `${target}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  let committed = false
  try {
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, ...profile }), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, target)
    committed = true
  } finally {
    if (!committed) unlinkSync(temporary)
  }
}
