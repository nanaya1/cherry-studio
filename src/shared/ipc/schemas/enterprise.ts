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
    input: z.void(),
    output: z.strictObject({ skills: z.array(orgSkillItemSchema) })
  }),
  'enterprise.skills.install': defineRoute({
    input: z.strictObject({ slug: z.string() }),
    output: z.strictObject({ ok: z.boolean() })
  }),
  'enterprise.skills.reportExec': defineRoute({
    input: z.strictObject({ slug: z.string(), detail: z.record(z.string(), z.unknown()).optional() }),
    output: z.strictObject({ ok: z.boolean() })
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
