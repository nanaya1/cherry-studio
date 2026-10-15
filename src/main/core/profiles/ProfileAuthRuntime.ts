import { createHash } from 'node:crypto'

import { session, type Cookie, type Session } from 'electron'

import { runAuthSessionOperation } from './AuthSessionProcess'
import { clearAllowedCookies, copyAllowedCookies, type CookieSessionPort } from './ProfileAuthSession'

export function getProfileAuthSession(profileRoot: string): Session {
  const digest = createHash('sha256').update(profileRoot).digest('hex')
  return session.fromPartition(`profile-auth-${digest}`)
}

export async function restoreProfileAuthSession(profileRoot: string, baseUrl: string): Promise<Session> {
  const cookies = await runAuthSessionOperation({ operation: 'read', profileRoot, baseUrl })
  const target = getProfileAuthSession(profileRoot)
  await clearAllowedCookies(target, baseUrl, ['sid'])
  await copyAllowedCookies(cookieSource(cookies, target), target, baseUrl, ['sid'])
  return target
}

export function cookieSource(cookies: Cookie[], target: CookieSessionPort): CookieSessionPort {
  return { fetch: target.fetch.bind(target), cookies: { ...target.cookies, get: async () => cookies } }
}
