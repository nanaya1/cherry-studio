import type { McpServer } from '../data/types/mcpServer'

const referencePrefix = 'cowork-external-knowledge:'

export interface ExternalKnowledgeSource {
  issuerId: string
  userId: string
  tenantId: string
  instanceId: string
}

// MEA:external-knowledge-connectors 来源写入既有reference字段，与手动项及普通企业MCP分开
export function externalKnowledgeReference(source: ExternalKnowledgeSource): string {
  return referencePrefix + encodeURIComponent(JSON.stringify(source))
}

export function parseExternalKnowledgeReference(reference?: string): ExternalKnowledgeSource | null {
  if (!reference?.startsWith(referencePrefix)) return null
  try {
    const source = JSON.parse(decodeURIComponent(reference.slice(referencePrefix.length)))
    if (
      !source ||
      !['issuerId', 'userId', 'tenantId', 'instanceId'].every(
        (key) => typeof source[key] === 'string' && source[key]
      ) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(source.instanceId)
    )
      return null
    return source
  } catch {
    return null
  }
}

export function isExternalKnowledgeConnector(server: Pick<McpServer, 'reference'>): boolean {
  return parseExternalKnowledgeReference(server.reference) !== null
}
