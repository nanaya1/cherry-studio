import { t } from '@main/i18n'
import { parseOrgId } from '@shared/data/types/enterpriseKnowledge'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'
import { IpcError } from '@shared/ipc/errors/IpcError'

import type { KnowledgeInspectionClient } from './KnowledgeInspectionClient'
import type { OrgAuthManager } from './OrgAuthManager'

/** MEA:enterprise-shared-space-view 每次管理读取在线核验角色，凭据及迟到响应绑定原身份租约。 */
export class KnowledgeInspection {
  constructor(private readonly auth: OrgAuthManager) {}

  private decode(id: string) {
    const raw = parseOrgId(id)
    if (!raw) throw new IpcError(E.ORGKB_BAD_INPUT, t('enterprise.knowledge.web.invalid_target'))
    return raw
  }
  private async run<T>(operation: (client: KnowledgeInspectionClient, guard: () => void) => Promise<T>): Promise<T> {
    let lease: ReturnType<OrgAuthManager['acquireLease']>
    try {
      lease = this.auth.acquireLease()
    } catch {
      throw new IpcError(E.ORGKB_UNAUTHORIZED, t('enterprise.knowledge.web.identity_required'))
    }
    const guard = () => {
      try {
        this.auth.assertLease(lease)
      } catch {
        throw new IpcError(E.ORGKB_UNAUTHORIZED, t('enterprise.knowledge.web.identity_required'))
      }
    }
    try {
      await this.auth.retryVerification()
      guard()
      const session = await this.auth.getValidSession()
      guard()
      if (!session || session.authMode !== 'management-java' || !['OWNER', 'ADMIN'].includes(session.role))
        throw new IpcError(E.ORGKB_FORBIDDEN, t('enterprise.knowledge.web.forbidden'))
      return await operation(this.auth.apiClient.knowledgeInspection(session, guard), guard)
    } finally {
      guard()
    }
  }
  spaces(params: { page: number; keyword?: string }) {
    return this.run((client, guard) => client.spaces(params, guard))
  }
  detail(params: { baseId: string }) {
    return this.run((client, guard) => client.detail(this.decode(params.baseId), guard))
  }
  files(params: { baseId: string; page: number; parentId?: string }) {
    return this.run((client, guard) =>
      client.files(
        this.decode(params.baseId),
        params.page,
        params.parentId ? this.decode(params.parentId) : undefined,
        guard
      )
    )
  }
  preview(params: { baseId: string; fileId: string }) {
    return this.run((client, guard) => client.previewUrl(this.decode(params.baseId), this.decode(params.fileId), guard))
  }
  content(params: { baseId: string; fileId: string }) {
    return this.run((client, guard) => client.content(this.decode(params.baseId), this.decode(params.fileId), guard))
  }
  chunks(params: { baseId: string; fileId: string; page: number }) {
    return this.run((client, guard) =>
      client.chunks(this.decode(params.baseId), this.decode(params.fileId), params.page, guard)
    )
  }
  invitations(params: { baseId: string; page: number }) {
    return this.run((client, guard) =>
      client.relations('invitation/page', this.decode(params.baseId), params.page, undefined, guard)
    )
  }
  links(params: { baseId: string; page: number }) {
    return this.run((client, guard) =>
      client.relations('share/page', this.decode(params.baseId), params.page, undefined, guard)
    )
  }
  receipts(params: { baseId: string; shareId: string; page: number }) {
    return this.run((client, guard) =>
      client.relations(
        'share/receipt/page',
        this.decode(params.baseId),
        params.page,
        this.decode(params.shareId),
        guard
      )
    )
  }
}
