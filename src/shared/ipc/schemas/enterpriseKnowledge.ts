import * as z from 'zod'

import {
  OrgKnowledgeUploadProgressSchema,
  OrgKnowledgeSyncPreviewSchema,
  OrgKnowledgeSyncApplySchema,
  OrgKnowledgeSyncStatusSchema,
  OrgKnowledgeCreateShareInputSchema,
  OrgKnowledgeReceiveShareInputSchema,
  OrgKnowledgeReceiveShareResultSchema,
  OrgKnowledgeShareSchema,
  OrgKnowledgeShareListSchema,
  OrgKnowledgeCatalogSchema,
  OrgKnowledgeChunkPageSchema,
  OrgKnowledgeInvitationListSchema,
  OrgKnowledgeItemPageSchema,
  OrgKnowledgeMemberListSchema,
  OrgKnowledgeMemberSchema,
  OrgKnowledgeCollaboratorListSchema,
  OrgKnowledgePreviewSchema,
  OrgKnowledgeReadResultSchema,
  OrgKnowledgeSearchResultSchema,
  OrgKnowledgeShareResultSchema,
  parseOrgId
} from '@shared/data/types/enterpriseKnowledge'

import { defineRoute } from '../define'

// 目标用户 ID 限定为安全正整数：避免 JS 数字精度丢失（服务端 user_id 为整数主键）。
const safePositiveUserId = z.number().int().positive().safe()

// 组织知识库 base/item/document/file/invitation 等 id 均为 orgkb: 编码字符串。
const orgId = z.string().min(1)
const cursor = z.string().min(1).nullable().optional()

/**
 * [enterprise] 组织知识库 IPC 契约。所有 base/item/document/file/invitation id 均为
 * `orgkb:` 编码；分享（share）的输入 baseId 为本地知识库 uuid（读取本地所属原文件用），
 * 不是 orgkb id。会话失效（401）与离线必须由主进程 fail closed 拒绝。
 */
const localBaseId = z
  .string()
  .min(1)
  .refine((id) => !id.startsWith('orgkb:'))

export const enterpriseKnowledgeRequestSchemas = {
  'enterprise.knowledge.pending_cleanup': defineRoute({
    input: z.void(),
    output: z.array(z.strictObject({ baseId: z.string(), localBaseId: z.string() }))
  }),
  'enterprise.knowledge.cleanup_local': defineRoute({
    // 无本机副本时 ID 为空；清理范围仅从主进程可信日志读取。
    input: z.strictObject({ baseId: z.string().min(1), localBaseId: z.string() }),
    output: z.strictObject({ ok: z.boolean(), localBaseId: z.string() })
  }),
  'enterprise.knowledge.local_groups': defineRoute({
    input: z.void(),
    output: z.record(z.string(), z.string())
  }),
  'enterprise.knowledge.move_local_group': defineRoute({
    input: z.strictObject({ baseId: orgId, groupId: z.string().min(1).nullable() }),
    output: z.void()
  }),
  'enterprise.knowledge.remove_local_group': defineRoute({
    input: z.strictObject({ groupId: z.string().min(1) }),
    output: z.void()
  }),
  'enterprise.knowledge.prepare_added_files': defineRoute({
    input: z.strictObject({ baseId: orgId }),
    output: z.strictObject({ localBaseId: z.string().min(1) })
  }),
  'enterprise.knowledge.upload_added_files': defineRoute({
    input: z.strictObject({ baseId: orgId, localBaseId, uploadOriginal: z.boolean().optional() }),
    output: OrgKnowledgeShareResultSchema
  }),
  'enterprise.knowledge.sync_preview': defineRoute({
    input: z.strictObject({ baseId: localBaseId }),
    output: OrgKnowledgeSyncPreviewSchema
  }),
  'enterprise.knowledge.sync_apply': defineRoute({
    input: z.strictObject({ baseId: localBaseId, planId: z.string().min(1), confirmDeletes: z.boolean() }),
    output: OrgKnowledgeSyncApplySchema
  }),
  'enterprise.knowledge.sync_status': defineRoute({
    input: z.strictObject({ baseId: localBaseId }),
    output: OrgKnowledgeSyncStatusSchema
  }),
  'enterprise.knowledge.catalog': defineRoute({ input: z.void(), output: OrgKnowledgeCatalogSchema }),
  'enterprise.knowledge.items': defineRoute({
    input: z.strictObject({ baseId: orgId, cursor }),
    output: OrgKnowledgeItemPageSchema
  }),
  'enterprise.knowledge.delete_file': defineRoute({
    input: z.strictObject({ baseId: orgId, fileId: orgId }),
    output: z.strictObject({ ok: z.literal(true) })
  }),
  'enterprise.knowledge.chunks': defineRoute({
    input: z.strictObject({ baseId: orgId, itemId: orgId, cursor }),
    output: OrgKnowledgeChunkPageSchema
  }),
  'enterprise.knowledge.search': defineRoute({
    input: z.strictObject({
      baseIds: z.array(orgId).min(1).max(32),
      query: z.string().trim().min(1).max(1000),
      topK: z.number().int().positive().max(50).optional(),
      rerank: z.boolean().optional()
    }),
    output: OrgKnowledgeSearchResultSchema
  }),
  'enterprise.knowledge.read': defineRoute({
    input: z.strictObject({ baseId: orgId, documentId: orgId, chunkId: orgId.nullable().optional() }),
    output: OrgKnowledgeReadResultSchema
  }),
  'enterprise.knowledge.preview': defineRoute({
    input: z.strictObject({ fileId: orgId }),
    output: OrgKnowledgePreviewSchema
  }),
  // 分享：输入为本地知识库 uuid，主进程读取其所属原文件与 chunks，不接收渲染进程路径/URL/Authorization。
  'enterprise.knowledge.upload_status': defineRoute({
    input: z.strictObject({ baseId: localBaseId }),
    output: OrgKnowledgeUploadProgressSchema.nullable()
  }),
  'enterprise.knowledge.upload_verify': defineRoute({
    input: z.strictObject({ baseId: localBaseId }),
    output: OrgKnowledgeShareResultSchema
  }),
  'enterprise.knowledge.share': defineRoute({
    input: z.strictObject({ baseId: z.string().min(1), uploadOriginal: z.boolean().default(true) }),
    output: OrgKnowledgeShareResultSchema
  }),
  // 取消分享：输入本地知识库 uuid，主进程删除云端 space 后解绑（本地副本保留），输出是否成功。
  'enterprise.knowledge.unshare_preview': defineRoute({
    input: z.strictObject({ baseId: z.string().min(1) }),
    output: z.strictObject({
      localBaseId: z.string(),
      phase: z.string(),
      restored: z.number(),
      missing: z.array(z.strictObject({ id: z.string(), name: z.string() }))
    })
  }),
  'enterprise.knowledge.unshare': defineRoute({
    input: z.strictObject({
      baseId: z.string().min(1),
      confirmMissing: z.boolean().optional(),
      confirmDevicesStopped: z.boolean().optional(),
      deleteLocal: z.boolean().optional()
    }),
    // output: z.strictObject({ ok: z.boolean(), localBaseId: z.string().min(1) })
    output: z.strictObject({ ok: z.boolean(), localBaseId: z.string() })
  }),
  'enterprise.knowledge.shares': defineRoute({
    input: z.strictObject({ baseId: orgId.refine((id) => !!parseOrgId(id)) }),
    output: OrgKnowledgeShareListSchema
  }),
  'enterprise.knowledge.create_share': defineRoute({
    input: OrgKnowledgeCreateShareInputSchema,
    output: OrgKnowledgeShareSchema
  }),
  'enterprise.knowledge.revoke_share': defineRoute({
    input: z.strictObject({
      baseId: orgId.refine((id) => !!parseOrgId(id)),
      shareId: orgId.refine((id) => !!parseOrgId(id))
    }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.knowledge.receive_share': defineRoute({
    input: OrgKnowledgeReceiveShareInputSchema,
    output: OrgKnowledgeReceiveShareResultSchema
  }),
  'enterprise.knowledge.members': defineRoute({
    input: z.strictObject({ baseId: orgId }),
    output: OrgKnowledgeMemberListSchema
  }),
  /**
   * [enterprise] 可邀请协作者（全局 active 用户）。输入仅 keyword/page/pageSize，分页与
   * 过滤全部由服务端完成；主进程只做会话鉴权与本人过滤，不虚构 total（原样回传服务端计数）。
   * 不使用 /api/users（含敏感信息且仅管理员可见）。
   */
  'enterprise.knowledge.collaborators': defineRoute({
    input: z.strictObject({
      keyword: z.string().trim().max(64).optional(),
      page: z.number().int().positive().max(1000).optional(),
      pageSize: z.number().int().positive().max(50).optional()
    }),
    output: OrgKnowledgeCollaboratorListSchema
  }),
  /**
   * [enterprise] 邀请：baseId 必须为本地知识库 uuid（渲染进程解析自本地库），主进程据此解析
   * 已完成的本地可信关联并校验 owner；不允许任意 orgkb 远端/公共/共享空间。邀请前拉取最新
   * members 阻止本人或仍生效（active/pending 等）的重复邀请；expired/removed 按实际契约放行。
   */
  'enterprise.knowledge.invite': defineRoute({
    input: z.strictObject({
      // baseId: localBaseId,
      baseId: z.union([localBaseId, orgId]),
      userId: safePositiveUserId,
      expireDays: z.number().int().positive().max(30).optional()
    }),
    output: OrgKnowledgeMemberSchema
  }),
  'enterprise.knowledge.invitations': defineRoute({ input: z.void(), output: OrgKnowledgeInvitationListSchema }),
  'enterprise.knowledge.accept': defineRoute({
    input: z.strictObject({ invitationId: orgId }),
    output: OrgKnowledgeMemberSchema
  }),
  'enterprise.knowledge.decline': defineRoute({
    input: z.strictObject({ invitationId: orgId }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.knowledge.remove_member': defineRoute({
    input: z.strictObject({ baseId: orgId, userId: safePositiveUserId }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  // 重命名：输入本地知识库 uuid（仅本人已绑定关联可改名），名称 1-128 字符，输出 void。
  'enterprise.knowledge.rename_shared': defineRoute({
    input: z.strictObject({ baseId: z.string().min(1), name: z.string().trim().min(1).max(128) }),
    output: z.void()
  })
}
