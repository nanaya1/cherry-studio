import { createHash } from 'node:crypto'
import path from 'node:path'

export type PersonalProfile =
  | { kind: 'guest' }
  | { kind: 'account'; serverInstanceId: string; userId: string; username?: string; displayName?: string }

export function resolvePersonalProfileLocation(dataRoot: string, profile: PersonalProfile): string {
  if (!path.isAbsolute(dataRoot)) throw new Error('Personal profile data root must be absolute')
  if (profile.kind === 'guest') return dataRoot

  const { serverInstanceId, userId } = profile
  if (!serverInstanceId.trim() || !/^[1-9][0-9]*$/.test(userId)) {
    throw new Error('Invalid personal profile identity')
  }

  const profileId = createHash('sha256')
    .update(JSON.stringify(['mea-personal-v1', serverInstanceId, userId]))
    .digest('hex')
  return path.join(dataRoot, 'PersonalProfiles', profileId)
}
