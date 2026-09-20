import * as z from 'zod'

import { defineRoute } from '../define'

// [enterprise] T0 企业扩展 IPC 契约。参考 cherryCloud.ts 模式。

export const enterpriseStatusSchema = z.strictObject({
  phase: z.enum(['signed-out', 'authorizing', 'signed-in']),
  phone: z.string().nullable(),
  role: z.string().nullable()
})

export type EnterpriseStatus = z.infer<typeof enterpriseStatusSchema>

const orgSkillItemSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  contentHash: z.string(),
  downloadUrl: z.string()
})

const orgConnectorItemSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.literal('sse'),
  baseUrl: z.string(),
  config: z.record(z.string(), z.unknown())
})

export const enterpriseRequestSchemas = {
  'enterprise.status.get': defineRoute({ input: z.void(), output: enterpriseStatusSchema }),
  'enterprise.login.start': defineRoute({
    input: z.void(),
    output: z.strictObject({ authorizationUrl: z.string() })
  }),
  'enterprise.session.logout': defineRoute({ input: z.void(), output: z.strictObject({ ok: z.boolean() }) }),
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
  'enterprise.skills.reportExec': defineRoute({
    input: z.strictObject({ slug: z.string(), detail: z.record(z.string(), z.unknown()).optional() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  // [enterprise] C2 停用拦截：渲染层构建技能注入前查询已停用 slug 列表
  'enterprise.skills.listDisabled': defineRoute({
    input: z.void(),
    output: z.strictObject({ disabled: z.array(z.string()) })
  }),
  // [enterprise] C4 删除上报：用户卸载 org 技能时上报 deleted 事件
  'enterprise.skills.reportDeleted': defineRoute({
    input: z.strictObject({ slug: z.string() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  // [enterprise] C3 组织可用性：登出后 org 资源标记不可用，重登恢复
  'enterprise.status.orgUnavailable': defineRoute({
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
