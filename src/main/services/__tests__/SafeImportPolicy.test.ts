import { describe, expect, it } from 'vitest'

import { shouldStripSafeImportPath } from '../SafeImportPolicy'

describe('shouldStripSafeImportPath', () => {
  it.each([
    'Credentials/meacowork-account.json',
    'Sensitive/Mcp/oauth/token.json',
    'Cookies',
    'Network/Cookies',
    'Session Storage/000003.log',
    'Sessions/Session_1',
    'Data/Mcp/OAuth/token.json',
    'Data/Copilot/token.enc',
    'Enterprise/org-session.json',
    'control/profiles.json',
    'profile-metadata.json',
    'nested/PROFILE/identity.json'
  ])('strips sensitive path %s case-insensitively', (relativePath) => {
    expect(shouldStripSafeImportPath(relativePath)).toBe(true)
  })

  it.each([
    'Data/Files/session-notes.md',
    'Data/Notes/enterprise-plan.md',
    'Data/Workspace/copilot-guide.md',
    'Data/Profiles/avatar.png',
    'Data/SensitiveAnalysis/report.md',
    'Data/Controllers/control-flow.json'
  ])('preserves non-sensitive path %s', (relativePath) => {
    expect(shouldStripSafeImportPath(relativePath)).toBe(false)
  })
})
