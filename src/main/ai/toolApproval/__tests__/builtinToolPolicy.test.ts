import { describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { KB_MANAGE_TOOL_NAME } from '@shared/ai/builtinTools'

import {
  findBuiltinToolPolicy,
  listBuiltinToolPolicies,
  toCherryBuiltinRuntimeName,
  toMcpRuntimeName
} from '../builtinToolPolicy'

// The builtin-tools server is now mounted under its canonical `meacowork-tools` id.
const WITHOUT_HOST_TOOLS: ReadonlySet<string> = new Set(['meacowork-tools', 'agent-memory', 'skills', 'mcp-manager'])
// Legacy mount name still accepted for warm sessions / older callers.
const LEGACY_MOUNT_TOOLS: ReadonlySet<string> = new Set(['cherry-tools', 'agent-memory', 'skills', 'mcp-manager'])
const WITH_HOST_TOOLS: ReadonlySet<string> = new Set([...WITHOUT_HOST_TOOLS, 'assistant', 'assistant-files'])

describe('builtinToolPolicy', () => {
  it('queries static policies before preferences are available', () => {
    const get = vi.spyOn(application.get('PreferenceService'), 'get').mockImplementation(() => {
      throw new Error('Preferences are not initialized')
    })
    try {
      expect(listBuiltinToolPolicies({ approval: 'auto' }).map(toMcpRuntimeName)).toContain('mcp__assistant__navigate')
      expect(findBuiltinToolPolicy('mcp__browser__click', WITHOUT_HOST_TOOLS)).toBeUndefined()
    } finally {
      get.mockRestore()
    }
  })

  it('authorizes known browser tools together and honors revocation without approving unknown tools', async () => {
    const preferences = application.get('PreferenceService')
    const mountedServers = new Set(['browser'])
    await preferences.set('app.browser.agent_control.enabled', true)
    for (const toolName of ['open', 'snapshot', 'click', 'scroll', 'execute', 'list_web_tools', 'call_web_tool']) {
      expect(findBuiltinToolPolicy(`mcp__browser__${toolName}`, mountedServers)?.approval).toBe('auto')
    }
    expect(findBuiltinToolPolicy('mcp__browser__future_tool', mountedServers)).toBeUndefined()
    expect(findBuiltinToolPolicy('mcp__browser__click', WITHOUT_HOST_TOOLS)).toBeUndefined()
    await preferences.set('app.browser.agent_control.enabled', false)
    expect(findBuiltinToolPolicy('mcp__browser__click', mountedServers)?.approval).toBe('required')
  })

  it('filters Assistant-only entries when their MCP servers are not mounted', () => {
    expect(findBuiltinToolPolicy('mcp__assistant__diagnose', WITHOUT_HOST_TOOLS)).toBeUndefined()
    expect(findBuiltinToolPolicy('mcp__assistant__diagnose', WITH_HOST_TOOLS)?.approval).toBe('required')
    expect(
      listBuiltinToolPolicies({ mountedServers: WITHOUT_HOST_TOOLS }).every((entry) =>
        WITHOUT_HOST_TOOLS.has(entry.serverName)
      )
    ).toBe(true)
  })

  it('does not auto-approve an undeclared future tool', () => {
    expect(findBuiltinToolPolicy('mcp__meacowork-tools__future_mutator', WITHOUT_HOST_TOOLS)).toBeUndefined()
    expect(
      listBuiltinToolPolicies({ approval: 'auto', mountedServers: WITHOUT_HOST_TOOLS })
        .map(toMcpRuntimeName)
        .includes('mcp__meacowork-tools__future_mutator')
    ).toBe(false)
  })

  it('resolves builtin policies through both the new and legacy server ids (rename compatibility)', () => {
    expect(findBuiltinToolPolicy(toCherryBuiltinRuntimeName(KB_MANAGE_TOOL_NAME), WITHOUT_HOST_TOOLS)?.approval).toBe(
      'required'
    )
    // Legacy wire name + legacy mounted id from a persisted warm session still resolve.
    expect(findBuiltinToolPolicy('mcp__cherry-tools__kb_manage', LEGACY_MOUNT_TOOLS)?.approval).toBe('required')
    // Mixed: new wire name with a legacy mount id, and vice versa.
    expect(findBuiltinToolPolicy('mcp__meacowork-tools__kb_manage', LEGACY_MOUNT_TOOLS)?.approval).toBe('required')
    expect(findBuiltinToolPolicy('mcp__cherry-tools__kb_manage', WITHOUT_HOST_TOOLS)?.approval).toBe('required')
    // Listing with the legacy mount set still surfaces the renamed builtin entries.
    expect(
      listBuiltinToolPolicies({ mountedServers: LEGACY_MOUNT_TOOLS }).some(
        (entry) => entry.toolName === KB_MANAGE_TOOL_NAME && entry.approval === 'required'
      )
    ).toBe(true)
  })

  it('auto-approves Session renames only when cherry-tools is mounted', () => {
    expect(findBuiltinToolPolicy('mcp__cherry-tools__session_rename', WITHOUT_HOST_TOOLS)?.approval).toBe('auto')
    expect(findBuiltinToolPolicy('mcp__cherry-tools__session_rename', new Set())).toBeUndefined()
  })
})
