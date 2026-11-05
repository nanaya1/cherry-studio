import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  skills: [
    { id: 'legacy-skill', source: 'org' },
    { id: 'local-skill', source: 'local' }
  ],
  connectors: [
    { id: 'legacy-mcp', installSource: 'org' },
    { id: 'manual-mcp', installSource: 'manual' }
  ],
  initializeAuth: vi.fn(async () => {}),
  initializeKnowledge: vi.fn()
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({ JobManager: {} })
})
vi.mock('@main/core/profiles', () => ({ getProfileLaunchContext: () => undefined }))
vi.mock('../ProfileOnlineMonitor', () => ({ ProfileOnlineMonitor: class {} }))
vi.mock('../OrgCredentialStore', () => ({ OrgCredentialStore: class {} }))
vi.mock('../OrgAuthManager', () => ({
  OrgAuthManager: class {
    initialize = state.initializeAuth
  }
}))
vi.mock('../OrgKnowledgeService', () => ({
  OrgKnowledgeService: class {
    initialize = state.initializeKnowledge
    dispose() {}
  }
}))
vi.mock('../OrgSkillCatalog', () => ({
  OrgSkillCatalog: class {
    migrateLegacyCopies() {
      const legacy = state.skills.filter((skill) => skill.source === 'org')
      for (const skill of legacy) skill.source = 'local'
      return legacy.length
    }
  }
}))
vi.mock('../OrgMcpCatalog', () => ({
  OrgMcpCatalog: class {
    migrateLegacyCopies() {
      const legacy = state.connectors.filter((connector) => connector.installSource === 'org')
      for (const connector of legacy) connector.installSource = 'manual'
      return legacy.length
    }
  }
}))

import { EnterprisePlugin } from '../EnterprisePlugin'

class StartupPlugin extends EnterprisePlugin {
  startForTest() {
    return this.onInit()
  }
}

describe('EnterprisePlugin startup resource preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.skills[0].source = 'org'
    state.connectors[0].installSource = 'org'
  })

  it('preserves existing skill and connector provenance during startup', async () => {
    const before = structuredClone({ skills: state.skills, connectors: state.connectors })

    await new StartupPlugin().startForTest()

    expect({ skills: state.skills, connectors: state.connectors }).toEqual(before)
    expect(state.initializeAuth).toHaveBeenCalledOnce()
    expect(state.initializeKnowledge).toHaveBeenCalledOnce()
  })
})
