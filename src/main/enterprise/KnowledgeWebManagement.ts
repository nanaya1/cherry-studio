import { shell } from 'electron'

import { t } from '@main/i18n'

import { javaResponseErrorMessage } from './JavaResponseError'
import { ORG_SERVER_BASE_URL } from './OrgApiClient'
import type { OrgAuthManager } from './OrgAuthManager'

/** 固定路由由主进程生成，禁止渲染进程提供外部URL或携带Token。 */
export async function openKnowledgeWebManagement(
  auth: OrgAuthManager,
  target: { id?: string; create: boolean }
): Promise<void> {
  const lease = auth.acquireLease()
  await auth.retryVerification()
  auth.assertLease(lease)
  const session = await auth.getValidSession()
  auth.assertLease(lease)
  if (!session || session.authMode !== 'management-java' || !['OWNER', 'ADMIN'].includes(session.role)) {
    throw new Error(t('enterprise.knowledge.web.forbidden'))
  }
  if (!session.tenantId || !/^[1-9]\d*$/.test(session.tenantId) || !/^[1-9]\d*$/.test(session.userId)) {
    throw new Error(t('enterprise.knowledge.web.identity_required'))
  }
  if (target.id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target.id)) {
    throw new Error(t('enterprise.knowledge.web.invalid_target'))
  }
  const configured = import.meta.env.MAIN_VITE_ORG_WEB_BASE_URL?.trim() || ORG_SERVER_BASE_URL
  if (!configured) throw new Error(t('enterprise.knowledge.web.invalid_url'))
  const root = new URL(configured)
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
    throw new Error(t('enterprise.knowledge.web.invalid_url'))
  }
  if (!root.pathname.endsWith('/')) root.pathname += '/'
  if (target.create) {
    // MEA:enterprise-knowledge-page 创建入口使用短期票据，源Token始终只发送给原认证服务。
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    let ticket: string
    try {
      const response = await fetch(new URL('/api/v1/client/auth/web-ticket', session.authOrigin), {
        method: 'POST',
        headers: { accept: 'application/json', token: session.accessToken },
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store'
      })
      auth.assertLease(lease)
      if (!response.ok) throw new Error(t('enterprise.knowledge.web.ticket_failed'))
      const body = await response.json()
      auth.assertLease(lease)
      if (typeof body?.code !== 'number' || !Number.isInteger(body.code)) {
        throw new Error(t('enterprise.knowledge.web.ticket_failed'))
      }
      if (body?.code !== 200) {
        throw new Error(javaResponseErrorMessage(body?.code, undefined, body?.requestId, '认证'))
      }
      const data = body.data
      if (
        typeof data?.ticket !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.ticket) ||
        data.expiresIn !== 60 ||
        data.userId !== session.userId ||
        data.tenantId !== session.tenantId
      ) {
        throw new Error(t('enterprise.knowledge.web.identity_required'))
      }
      ticket = data.ticket
    } catch (error) {
      auth.assertLease(lease)
      if (error instanceof SyntaxError || error instanceof TypeError || controller.signal.aborted) {
        throw new Error(t('enterprise.knowledge.web.ticket_failed'))
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    const callback = new URL('client/callback', root)
    callback.hash = new URLSearchParams({ ticket }).toString()
    auth.assertLease(lease)
    try {
      await shell.openExternal(callback.href)
    } catch {
      // Electron错误可能包含完整URL，不能把一次性票据传给IPC日志或提示。
      throw new Error(t('enterprise.knowledge.web.ticket_failed'))
    }
    auth.assertLease(lease)
    return
  }
  const url = new URL(target.id && !target.create ? `knowledge/${target.id}` : 'knowledge', root)
  url.searchParams.set('clientTenantId', session.tenantId)
  url.searchParams.set('clientUserId', session.userId)
  // 创建跳转已由上方一次性票据接管，保留原实现便于对照回退。
  // if (target.create) {
  //   url.searchParams.set('category', 'public')
  //   url.searchParams.set('action', 'create')
  // }
  auth.assertLease(lease)
  await shell.openExternal(url.href)
  auth.assertLease(lease)
}
