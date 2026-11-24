import { shell } from 'electron'

import { t } from '@main/i18n'

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
  const url = new URL(target.id && !target.create ? `knowledge/${target.id}` : 'knowledge', root)
  url.searchParams.set('clientTenantId', session.tenantId)
  url.searchParams.set('clientUserId', session.userId)
  if (target.create) {
    url.searchParams.set('category', 'public')
    url.searchParams.set('action', 'create')
  }
  auth.assertLease(lease)
  await shell.openExternal(url.href)
  auth.assertLease(lease)
}
