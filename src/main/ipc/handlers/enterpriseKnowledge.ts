import { application } from '@application'
import { OrgApiHttpError } from '@main/enterprise/OrgApiClient'
import { OrgKnowledgeProtocolError } from '@main/enterprise/OrgKnowledgeClient'
import { OrgKnowledgeError } from '@main/enterprise/OrgKnowledgeService'
import { enterpriseKnowledgeErrorCodes } from '@shared/ipc/errors/enterpriseKnowledge'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { enterpriseKnowledgeRequestSchemas } from '@shared/ipc/schemas/enterpriseKnowledge'
import type { IpcHandlersFor } from '@shared/ipc/types'

/**
 * [enterprise] 组织知识库 IPC 处理器：委托 EnterprisePlugin.knowledge，错误统一映射为领域 IpcError。
 * 会话失效（401）/离线/协议错误均 fail closed 拒绝，不回退到任何陈旧数据。
 */
function mapError(e: unknown): never {
  if (e instanceof IpcError) throw e
  if (e instanceof OrgKnowledgeError) throw new IpcError(e.code, e.message)
  if (e instanceof OrgKnowledgeProtocolError)
    throw new IpcError(enterpriseKnowledgeErrorCodes.ORGKB_PROTOCOL, e.message)
  if (e instanceof OrgApiHttpError) {
    const code =
      e.status === 401
        ? enterpriseKnowledgeErrorCodes.ORGKB_UNAUTHORIZED
        : e.status === 403
          ? enterpriseKnowledgeErrorCodes.ORGKB_FORBIDDEN
          : e.status === 404
            ? enterpriseKnowledgeErrorCodes.ORGKB_NOT_FOUND
            : e.status >= 500
              ? enterpriseKnowledgeErrorCodes.ORGKB_SERVER_ERROR
              : enterpriseKnowledgeErrorCodes.ORGKB_BAD_INPUT
    throw new IpcError(code, e.message)
  }
  if (e instanceof Error && e.message.includes('未登录')) {
    throw new IpcError(enterpriseKnowledgeErrorCodes.ORGKB_UNAUTHORIZED, e.message)
  }
  throw new IpcError(enterpriseKnowledgeErrorCodes.ORGKB_UNKNOWN, e instanceof Error ? e.message : String(e))
}

function guard<R>(fn: () => Promise<R>): Promise<R> {
  return fn().catch((e) => mapError(e))
}

const plugin = () => application.get('EnterprisePlugin')

export const enterpriseKnowledgeHandlers: IpcHandlersFor<typeof enterpriseKnowledgeRequestSchemas> = {
  'enterprise.knowledge.pending_cleanup': () => guard(() => plugin().knowledge.pendingCleanup()),
  'enterprise.knowledge.cleanup_local': (params) => guard(() => plugin().knowledge.cleanupLocal(params)),
  'enterprise.knowledge.local_groups': () => guard(() => plugin().knowledge.localGroups()),
  'enterprise.knowledge.move_local_group': ({ baseId, groupId }) =>
    guard(() => plugin().knowledge.moveLocalGroup(baseId, groupId)),
  'enterprise.knowledge.remove_local_group': ({ groupId }) => guard(() => plugin().knowledge.removeLocalGroup(groupId)),
  'enterprise.knowledge.sync_preview': (params) => guard(() => plugin().knowledge.syncPreview(params)),
  'enterprise.knowledge.sync_apply': () =>
    guard(async () => {
      throw new OrgKnowledgeError(
        enterpriseKnowledgeErrorCodes.ORGKB_FORBIDDEN,
        '旧本地推送已停用，请在云端详情新增文件'
      )
    }),
  'enterprise.knowledge.prepare_added_files': ({ baseId }) => guard(() => plugin().knowledge.prepareAddedFiles(baseId)),
  'enterprise.knowledge.add_files': ({ baseId, localBaseId, items, conflictStrategy }) =>
    guard(() => plugin().knowledge.addFiles(baseId, localBaseId, items, conflictStrategy)),
  'enterprise.knowledge.upload_added_files': ({ baseId, localBaseId, uploadOriginal }) =>
    guard(() => plugin().knowledge.uploadAddedFiles(baseId, localBaseId, uploadOriginal)),
  'enterprise.knowledge.sync_status': (params) => guard(() => plugin().knowledge.syncStatus(params)),
  'enterprise.knowledge.catalog': () => guard(() => plugin().knowledge.catalog()),
  'enterprise.knowledge.items': ({ baseId, cursor, parentId }) =>
    guard(() => plugin().knowledge.listDirectoryItems(baseId, cursor ?? null, parentId ?? null)),
  'enterprise.knowledge.delete_file': (params) => guard(() => plugin().knowledge.deleteFile(params)),
  'enterprise.knowledge.chunks': ({ baseId, itemId, cursor }) =>
    guard(() => plugin().knowledge.listChunks(baseId, itemId, cursor ?? null)),
  'enterprise.knowledge.search': ({ baseIds, query, topK, rerank }) =>
    guard(() => plugin().knowledge.search({ baseIds, query, topK, rerank })),
  'enterprise.knowledge.read': ({ baseId, documentId, chunkId }) =>
    guard(() => plugin().knowledge.read({ baseId, documentId, chunkId: chunkId ?? null })),
  'enterprise.knowledge.preview': ({ fileId }) => guard(() => plugin().knowledge.preview({ fileId })),
  'enterprise.knowledge.upload_status': ({ baseId }) => guard(() => plugin().knowledge.uploadStatus(baseId)),
  'enterprise.knowledge.upload_verify': ({ baseId }) => guard(() => plugin().knowledge.share(baseId, true)),
  // 'enterprise.knowledge.share': ({ baseId }) => guard(() => plugin().knowledge.share(baseId)),
  'enterprise.knowledge.share': ({ baseId, uploadOriginal }) =>
    guard(() => plugin().knowledge.share(baseId, false, uploadOriginal)),
  // 'enterprise.knowledge.unshare': ({ baseId }) => guard(() => plugin().knowledge.unshare({ baseId })),
  'enterprise.knowledge.unshare_preview': (params) => guard(() => plugin().knowledge.unsharePreview(params)),
  'enterprise.knowledge.unshare': (params) => guard(() => plugin().knowledge.unshare(params)),
  'enterprise.knowledge.shares': (params) => guard(() => plugin().knowledge.shares(params)),
  'enterprise.knowledge.create_share': (params) => guard(() => plugin().knowledge.createShareCode(params)),
  'enterprise.knowledge.revoke_share': (params) => guard(() => plugin().knowledge.revokeShare(params)),
  'enterprise.knowledge.receive_share': (params) => guard(() => plugin().knowledge.receiveShare(params)),
  'enterprise.knowledge.members': ({ baseId }) => guard(() => plugin().knowledge.members({ baseId })),
  'enterprise.knowledge.collaborators': ({ keyword, page, pageSize }) =>
    guard(() => plugin().knowledge.collaborators({ keyword, page, pageSize })),
  'enterprise.knowledge.invite': ({ baseId, userId, expireDays }) =>
    guard(() => plugin().knowledge.invite({ baseId, userId, expireDays })),
  'enterprise.knowledge.invitations': () => guard(() => plugin().knowledge.invitations()),
  'enterprise.knowledge.accept': ({ invitationId }) => guard(() => plugin().knowledge.accept({ invitationId })),
  'enterprise.knowledge.decline': ({ invitationId }) => guard(() => plugin().knowledge.decline({ invitationId })),
  'enterprise.knowledge.remove_member': ({ baseId, userId }) =>
    guard(() => plugin().knowledge.removeMember({ baseId, userId })),
  'enterprise.knowledge.rename_shared': ({ baseId, name }) =>
    guard(() => plugin().knowledge.renameSharedBase(baseId, name))
}
