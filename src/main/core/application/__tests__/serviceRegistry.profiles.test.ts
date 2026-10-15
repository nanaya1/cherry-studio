import { describe, expect, it } from 'vitest'

import type { ServiceConstructor } from '@main/core/lifecycle'

import { bootstrapServiceList, getServiceListForProfileMode, serviceNameList } from '../serviceRegistryGroups'

class DbService {}
class McpRuntimeService {}
class KnowledgeService {}
class AgentLifecycleService {}
class AutoBackupService {}
class SafeBootstrapService {}

const businessServiceList = [
  DbService,
  McpRuntimeService,
  KnowledgeService,
  AgentLifecycleService,
  AutoBackupService
] as ServiceConstructor[]
const FORBIDDEN_SIGNED_OUT_PATTERNS = [/Db/i, /Mcp/i, /Knowledge/i, /Agent/i, /AutoBackup/i]

describe('profile-aware service registry', () => {
  it('defines bootstrap services separately from business services', () => {
    expect(bootstrapServiceList).not.toBe(businessServiceList)
    expect(serviceNameList(businessServiceList)).toEqual([
      'DbService',
      'McpRuntimeService',
      'KnowledgeService',
      'AgentLifecycleService',
      'AutoBackupService'
    ])
  })

  it.each(['signed-out', 'migration-required', 'recovery'] as const)(
    'does not include Db/MCP/Knowledge/Agent/AutoBackup services in %s mode',
    (mode) => {
      const names = serviceNameList(getServiceListForProfileMode(mode, businessServiceList))
      for (const pattern of FORBIDDEN_SIGNED_OUT_PATTERNS) {
        expect(names).not.toEqual(expect.arrayContaining([expect.stringMatching(pattern)]))
      }
    }
  )

  it('keeps bootstrap and business services for business mode', () => {
    const safeBootstrapList = [SafeBootstrapService] as ServiceConstructor[]
    const selected = getServiceListForProfileMode('business', businessServiceList)
    expect(selected).toEqual([...bootstrapServiceList, ...businessServiceList])
    expect(getServiceListForProfileMode('signed-out', safeBootstrapList)).toEqual(bootstrapServiceList)
  })
})
