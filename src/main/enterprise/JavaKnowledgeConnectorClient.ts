import * as z from 'zod'

const identity = z.number().int().positive().safe().transform(String)
const instanceSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: z.string().min(1),
  description: z.string(),
  type: z.literal('streamableHttp'),
  baseUrl: z.string().refine((value) => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }),
  headers: z.strictObject({ 'mcp-key': z.string().regex(/^ck_[0-9a-f]{32}$/) })
})
const snapshotSchema = z
  .object({
    userId: identity,
    tenantId: identity,
    items: z.array(instanceSchema).max(1000)
  })
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length)

export type JavaKnowledgeConnector = z.infer<typeof instanceSchema>
export type JavaKnowledgeConnectorSnapshot = z.infer<typeof snapshotSchema>

export class JavaKnowledgeConnectorError extends Error {
  constructor(readonly code: number) {
    super(code === 10007 || code === 10008 ? '外部知识库访问权限已失效' : '外部知识库查询失败，请稍后重试')
    this.name = 'JavaKnowledgeConnectorError'
  }
}

export class JavaKnowledgeConnectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async list(): Promise<JavaKnowledgeConnectorSnapshot> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      // MEA:external-knowledge-connectors 固定当前凭据，原始响应及Key不进入日志或目录IPC
      const response = await fetch(`${new URL(this.baseUrl).origin}/api/v1/client/knowledge/connectors/list`, {
        method: 'GET',
        headers: { accept: 'application/json', token: this.token },
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store'
      })
      if (response.status === 401 || response.status === 403)
        throw new JavaKnowledgeConnectorError(response.status === 401 ? 10008 : 10007)
      if (!response.ok) throw new JavaKnowledgeConnectorError(500)
      const body: unknown = await response.json()
      const envelope = z.object({ code: z.number().int(), data: z.unknown().optional() }).safeParse(body)
      if (!envelope.success) throw new JavaKnowledgeConnectorError(500)
      if (envelope.data.code !== 200) throw new JavaKnowledgeConnectorError(envelope.data.code)
      const snapshot = snapshotSchema.safeParse(envelope.data.data)
      if (!snapshot.success) throw new JavaKnowledgeConnectorError(500)
      return snapshot.data
    } catch (error) {
      if (error instanceof JavaKnowledgeConnectorError) throw error
      throw new JavaKnowledgeConnectorError(500)
    } finally {
      clearTimeout(timeout)
    }
  }
}
