import * as z from 'zod'

import { parseJavaResourceKey } from '../../utils/javaResourceKey'
import { defineRoute } from '../define'

// [enterprise] T0 企业扩展 IPC 契约。参考 cherryCloud.ts 模式。

export const enterpriseStatusSchema = z.strictObject({
  phase: z.enum(['signed-out', 'authorizing', 'signed-in', 'switching']),
  generation: z.number().int().nonnegative(),
  groupId: z.string().nullable(),
  // authMode: z.enum(['management-exchange', 'management-oauth', 'official-direct']),
  // authMode: z.enum(['management-exchange', 'management-oauth', 'management-cookie', 'official-direct']),
  authMode: z.enum([
    'management-exchange',
    'management-oauth',
    'management-cookie',
    'official-direct',
    'management-java'
  ]),
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable()
})

export type EnterpriseStatus = z.infer<typeof enterpriseStatusSchema>

// [enterprise] 分类/标签 facet：只透传展示所需字段，忽略服务端其余字段（id/sort_order/enabled 等）
// 注意：IpcRouter 只运行时校验 input，output 是编译期契约；字符串→facet 的归一化在 OrgSkillCatalog 完成
const orgSkillFacetSchema = z.strictObject({
  code: z.string(),
  name: z.string()
})

const orgSkillItemSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  contentHash: z.string(),
  downloadUrl: z.string(),
  iconUrl: z.string().nullable().optional(),
  categories: z.array(orgSkillFacetSchema).optional(),
  tags: z.array(orgSkillFacetSchema).optional()
})

const orgConnectorItemSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  // 目录 v2 与管理台快速创建对齐：stdio/sse/streamableHttp（旧服务端恒为 sse）
  type: z.enum(['stdio', 'sse', 'streamableHttp']),
  baseUrl: z.string(),
  config: z.record(z.string(), z.unknown())
})

const javaConnectorKeySchema = z
  .string()
  // .regex(/^java-resource:[a-f0-9]{32}:mcp:[1-9][0-9]*$/)
  // MEA:enterprise-java-resources Java部署实例也使用带横杠UUID，保留原值隔离。
  // .regex(/^java-resource:(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):mcp:[1-9][0-9]*$/)
  // .refine((value) => Number.isSafeInteger(Number(value.split(':').at(-1))))
  .refine((value) => parseJavaResourceKey(value)?.resourceType === 'mcp')

const javaConnectorItemSchema = z.strictObject({
  id: z.string(),
  resourceKey: javaConnectorKeySchema,
  name: z.string(),
  description: z.string(),
  slug: z.string(),
  tenantId: z.string().nullable(),
  type: z.enum(['stdio', 'sse', 'streamableHttp']).nullable(),
  baseUrl: z.string(),
  config: z.record(z.string(), z.unknown()),
  configurationError: z.string().nullable(),
  iconUrl: z.string().nullable()
})

const javaSkillKeySchema = z
  .string()
  // .regex(/^java-resource:[a-f0-9]{32}:skill:[1-9][0-9]*$/)
  // .regex(/^java-resource:(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):skill:[1-9][0-9]*$/)
  // .refine((value) => Number.isSafeInteger(Number(value.split(':').at(-1))))
  .refine((value) => parseJavaResourceKey(value)?.resourceType === 'skill')

const javaSkillItemSchema = z.strictObject({
  id: z.string(),
  resourceKey: javaSkillKeySchema,
  tenantId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  contentHash: z.string(),
  iconUrl: z.string().nullable(),
  categories: z.array(orgSkillFacetSchema),
  tags: z.array(orgSkillFacetSchema)
})

export const enterpriseRequestSchemas = {
  'enterprise.skills.list_resources': defineRoute({
    input: z.void(),
    output: z.strictObject({ skills: z.array(javaSkillItemSchema), installedKeys: z.array(z.string()) })
  }),
  'enterprise.skills.install_resource': defineRoute({
    input: z.strictObject({ resourceKey: javaSkillKeySchema }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.skills.remove_resource': defineRoute({
    input: z.strictObject({ resourceKey: javaSkillKeySchema }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.connectors.list_resources': defineRoute({
    input: z.void(),
    output: z.strictObject({ connectors: z.array(javaConnectorItemSchema), installedKeys: z.array(z.string()) })
  }),
  'enterprise.connectors.install_resource': defineRoute({
    input: z.strictObject({ resourceKey: javaConnectorKeySchema }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.status.get': defineRoute({ input: z.void(), output: enterpriseStatusSchema }),
  'enterprise.login.start': defineRoute({
    input: z.void(),
    output: z.strictObject({ authorizationUrl: z.string() })
  }),
  'enterprise.session.logout': defineRoute({
    input: z.void(),
    output: z.strictObject({
      state: z.enum(['switching', 'signed-out']),
      revocationWarning: z.string().nullable()
    })
  }),
  'enterprise.skills.list': defineRoute({
    // force: UI 手动刷新时穿透主进程目录 TTL 缓存；默认空对象兼容旧窗口的无参调用
    input: z.strictObject({ force: z.boolean().optional() }).default({}),
    // [enterprise] installedSlugs：本地已安装的 org 技能 slug（对话框标记「已安装」状态）
    output: z.strictObject({ skills: z.array(orgSkillItemSchema), installedSlugs: z.array(z.string()) })
  }),
  'enterprise.skills.install': defineRoute({
    input: z.strictObject({ slug: z.string() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.skills.report_exec': defineRoute({
    input: z.strictObject({ slug: z.string(), detail: z.record(z.string(), z.unknown()).optional() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  // [enterprise] C2 停用拦截：渲染层构建技能注入前查询已停用 slug 列表
  'enterprise.skills.list_disabled': defineRoute({
    input: z.void(),
    output: z.strictObject({ disabled: z.array(z.string()) })
  }),
  // [enterprise] C4 删除上报：用户卸载 org 技能时上报 deleted 事件
  'enterprise.skills.report_deleted': defineRoute({
    input: z.strictObject({ slug: z.string() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  // [enterprise] C3 组织可用性：登出后 org 资源标记不可用，重登恢复
  'enterprise.status.org_unavailable': defineRoute({
    input: z.void(),
    output: z.strictObject({ unavailable: z.boolean() })
  }),
  'enterprise.connectors.list': defineRoute({
    input: z.void(),
    output: z.strictObject({ connectors: z.array(orgConnectorItemSchema) })
  }),
  'enterprise.connectors.install': defineRoute({
    input: z.strictObject({ slug: z.string() }),
    output: z.strictObject({ ok: z.boolean() })
  })
}

export type EnterpriseEventSchemas = {
  'enterprise.status_changed': EnterpriseStatus
}
