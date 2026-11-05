/* import { session } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import {
  clearAllowedCookies,
  copyAllowedCookies,
  fetchCurrentUserViaSession,
  readAllowedCookies,
  // resolveAuthSessionPath,
  type CookieSessionPort,
  type ProfileSessionService
} from '@main/core/profiles'
import { runAuthSessionOperation, getProfileAuthSession, cookieToSetDetails } from '@main/core/profiles'

*/
import type { ProfileSessionService } from '@main/core/profiles'

import { JavaAuthClient } from './JavaAuthClient'
import { ORG_SERVER_BASE_URL } from './OrgApiClient'
import { PasswordProfileLogin } from './PasswordProfileLogin'
// import { ProfileAuthBroker } from './ProfileAuthBroker'

export function createPasswordProfileLogin(
  profileSession: ProfileSessionService
  // sessions = session
): PasswordProfileLogin {
  const baseUrl = ORG_SERVER_BASE_URL
  if (!baseUrl) throw new Error('Management server is not configured')
  return new PasswordProfileLogin({
    baseUrl,
    // MEA:enterprise-java-auth 不创建或复制 Cookie；safeStorage 仍由原事务提交。
    client: new JavaAuthClient({ baseUrl, publicKeyBase64: import.meta.env.MAIN_VITE_ORG_RSA_PUBLIC_KEY }),
    /* createTemporarySession: () => sessions.fromPartition(`profile-login-${uuidv4()}`),
    clearTemporary: async (temporary) => {
      await clearAllowedCookies(temporary as CookieSessionPort, baseUrl, ['sid'])
    },
    prepareTarget: async (temporary, root, identity) => {
      const source = temporary as CookieSessionPort
      // const target = sessions.fromPath(resolveAuthSessionPath(root))
      const isolated = sessions === session
      const target = isolated ? getProfileAuthSession(root) : sessions.fromPath(root)
      const incoming = await readAllowedCookies(source, baseUrl, ['sid'])
      if (incoming.length !== 1 || incoming[0].session) {
        throw new Error('Password login requires one persistent sid cookie')
      }
      const previous = isolated
        ? await runAuthSessionOperation({ operation: 'read', profileRoot: root, baseUrl })
        : await readAllowedCookies(target, baseUrl, ['sid'])
      const restore = async () => {
        if (isolated)
          await runAuthSessionOperation({
            operation: 'replace',
            profileRoot: root,
            baseUrl,
            cookies: previous.map((cookie) => cookieToSetDetails(cookie, baseUrl))
          })
        await clearAllowedCookies(target, baseUrl, ['sid'])
        await copyAllowedCookies(
          {
            fetch: target.fetch.bind(target),
            cookies: {
              get: async () => previous,
              set: target.cookies.set.bind(target.cookies),
              remove: target.cookies.remove.bind(target.cookies)
            }
          },
          target,
          baseUrl,
          ['sid']
        )
      }
      try {
        if (isolated) {
          await runAuthSessionOperation({
            operation: 'replace',
            profileRoot: root,
            baseUrl,
            cookies: incoming.map((cookie) => cookieToSetDetails(cookie, baseUrl))
          })
          const recovered = await runAuthSessionOperation({ operation: 'read', profileRoot: root, baseUrl })
          if (recovered.length !== 1 || recovered[0].value !== incoming[0].value) {
            throw new Error('Target sid did not survive auth process restart')
          }
        }
        await clearAllowedCookies(target, baseUrl, ['sid'])
        await copyAllowedCookies(source, target, baseUrl, ['sid'])
        const broker = new ProfileAuthBroker(
          { getCurrentUser: () => fetchCurrentUserViaSession(target, baseUrl) },
          baseUrl
        )
        const verified = await broker.revalidateManagement('management-cookie', identity)
        if (
          verified.session.userId !== identity.userId ||
          verified.session.issuerId !== identity.issuerId ||
          verified.session.groupId !== identity.groupId ||
          verified.session.role !== identity.role
        ) {
          throw new Error('Target cookie identity or authorization changed during login')
        }
        return restore
      } catch (error) {
        await restore()
        throw error
      }
    },
    */
    completeAuthentication: (authentication) => profileSession.completeAuthentication(authentication)
  })
}
