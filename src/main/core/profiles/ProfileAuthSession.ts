/**
 * [profiles] Isolated auth cookie session helpers for password (`sid`) login.
 *
 * Electron-free on purpose: every operation takes a `CookieSessionPort` (the real
 * Electron `Session` satisfies it), so copy/flush/re-verify is unit-testable with
 * fakes and there is no reverse dependency from `enterprise` onto `preboot`.
 */
import path from 'node:path'

import type { Cookie, CookiesSetDetails } from 'electron'

import type { OrgCurrentUser } from '@main/enterprise/types'

export interface CookieSessionPort {
  fetch(url: string, init?: RequestInit): Promise<Response>
  cookies: {
    get(filter: { url?: string; name?: string; domain?: string }): Promise<Cookie[]>
    set(details: CookiesSetDetails): Promise<void>
    flushStore?(): Promise<void>
    remove(url: string, name: string): Promise<void>
  }
}

/** Isolated auth session storage path for a profile — the durable `sid` cookie jar. */
export function resolveAuthSessionPath(profileRoot: string): string {
  return path.join(profileRoot, 'Session', 'auth')
}

function cookieUrl(cookie: Pick<Cookie, 'path'>, origin: string): string {
  return new URL(cookie.path && cookie.path.length > 0 ? cookie.path : '/', origin).href
}

export function cookieToSetDetails(cookie: Cookie, origin: string): CookiesSetDetails {
  return {
    url: cookieUrl(cookie, origin),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  }
}

/**
 * Recoverable copy: move the allowed cookie names (e.g. `sid`) from the temporary
 * login jar into the durable target auth jar, then flush so a crash between copy
 * and commit does not leave a half-written jar. Does not touch unrelated cookies.
 */
export async function copyAllowedCookies(
  source: CookieSessionPort,
  target: CookieSessionPort,
  origin: string,
  allowedNames: string[]
): Promise<void> {
  const cookies = await source.cookies.get({ url: origin })
  const selected = cookies.filter((cookie) => allowedNames.includes(cookie.name))
  for (const cookie of selected) {
    await target.cookies.set(cookieToSetDetails(cookie, origin))
  }
  if (target.cookies.flushStore) await target.cookies.flushStore()
}

/** Read back the allowed names from a jar after flush, to verify persistence. */
export async function readAllowedCookies(
  session: CookieSessionPort,
  origin: string,
  allowedNames: string[]
): Promise<Cookie[]> {
  const cookies = await session.cookies.get({ url: origin })
  return cookies.filter((cookie) => allowedNames.includes(cookie.name))
}

/** Remove the allowed names from a jar (used on logout and temp-session cleanup). */
export async function clearAllowedCookies(
  session: CookieSessionPort,
  origin: string,
  allowedNames: string[]
): Promise<void> {
  const cookies = await session.cookies.get({ url: origin })
  for (const cookie of cookies.filter((cookie) => allowedNames.includes(cookie.name))) {
    await session.cookies.remove(cookieUrl(cookie, origin), cookie.name)
  }
  if (session.cookies.flushStore) await session.cookies.flushStore()
}

/**
 * Cookie contract `GET /api/currentuser`: the Electron session's `fetch` carries
 * the partition's `sid` cookie automatically, so no Bearer header is attached.
 */
export async function fetchCurrentUserViaSession(
  session: CookieSessionPort,
  baseUrl: string,
  timeoutMs = 10_000
): Promise<OrgCurrentUser> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await session.fetch(`${baseUrl}/api/currentuser`, {
      credentials: 'include',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`currentuser request failed (${response.status})`)
    return (await response.json()) as OrgCurrentUser
  } finally {
    clearTimeout(timer)
  }
}
