import { describe, expect, it } from 'vitest'

import {
  isMeacoworkToolRuntimeName,
  isMeacoworkToolsServerName,
  migrateLegacyMeacoworkToolRuntimeNames,
  toMeacoworkToolRuntimeName
} from '../meacoworkTools'

describe('MEA Cowork tool protocol names', () => {
  it('writes the meacowork-tools protocol name', () => {
    expect(toMeacoworkToolRuntimeName('web_search')).toBe('mcp__meacowork-tools__web_search')
  })

  it('recognizes both current and legacy protocol names when reading history', () => {
    expect(isMeacoworkToolsServerName('meacowork-tools')).toBe(true)
    expect(isMeacoworkToolsServerName('cherry-tools')).toBe(true)
    expect(isMeacoworkToolRuntimeName('mcp__meacowork-tools__web_search')).toBe(true)
    expect(isMeacoworkToolRuntimeName('mcp__cherry-tools__web_search')).toBe(true)
  })

  it('migrates persisted disabled tools without duplicates', () => {
    expect(
      migrateLegacyMeacoworkToolRuntimeNames([
        'Bash',
        'mcp__cherry-tools',
        'mcp__cherry-tools__*',
        'mcp__cherry-tools__web_search',
        'mcp__meacowork-tools__web_search'
      ])
    ).toEqual(['Bash', 'mcp__meacowork-tools', 'mcp__meacowork-tools__*', 'mcp__meacowork-tools__web_search'])
  })
})
