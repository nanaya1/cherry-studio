import { describe, expect, it } from 'vitest'

import {
  buildClaudeMcpToolName,
  type ClaudeToolDescriptor,
  matchesClaudeToolRule,
  resolveClaudeToolAccess,
  resolveClaudeToolInvocationAccess
} from '../toolRules'

describe('Claude Code tool rules', () => {
  const read: ClaudeToolDescriptor = {
    id: 'Read',
    name: 'Read',
    origin: 'builtin'
  }

  const edit: ClaudeToolDescriptor = {
    id: 'Edit',
    name: 'Edit',
    origin: 'builtin'
  }

  const webSearch: ClaudeToolDescriptor = {
    id: 'WebSearch',
    name: 'WebSearch',
    origin: 'builtin'
  }

  const mcpSearch: ClaudeToolDescriptor = {
    id: buildClaudeMcpToolName('docs', 'search_docs'),
    name: 'search_docs',
    origin: 'mcp',
    sourceId: 'server-1',
    sourceName: 'docs',
    sourceToolName: 'search_docs'
  }

  it('matches Claude native builtin rules', () => {
    expect(matchesClaudeToolRule('Read', read)).toBe(true)
    expect(matchesClaudeToolRule('builtin_Read', read)).toBe(true)
  })

  it('matches Claude MCP runtime rules', () => {
    expect(matchesClaudeToolRule('mcp__docs__searchDocs', mcpSearch)).toBe(true)
    expect(matchesClaudeToolRule('mcp__docs__search_docs', mcpSearch)).toBe(true)
    expect(matchesClaudeToolRule('mcp__docs__*', mcpSearch)).toBe(true)
    expect(matchesClaudeToolRule('search_docs', mcpSearch)).toBe(false)
    expect(matchesClaudeToolRule('mcp__other__searchDocs', mcpSearch)).toBe(false)
  })

  it('matches legacy server-name rules for the renamed builtin-tools server', () => {
    const builtinSearch: ClaudeToolDescriptor = {
      ...mcpSearch,
      id: buildClaudeMcpToolName('meacowork-tools', 'web_search'),
      name: 'web_search',
      sourceId: 'builtin',
      sourceName: 'meacowork-tools',
      sourceToolName: 'web_search'
    }
    expect(matchesClaudeToolRule('mcp__meacowork-tools__web_search', builtinSearch)).toBe(true)
    // Persisted rules from before the cherry-tools → meacowork-tools rename still match.
    expect(matchesClaudeToolRule('mcp__cherry-tools__web_search', builtinSearch)).toBe(true)
    expect(matchesClaudeToolRule('mcp__cherry-tools__*', builtinSearch)).toBe(true)
    expect(matchesClaudeToolRule('mcp__other__web_search', builtinSearch)).toBe(false)
  })

  it('lets source force-prompt override mode defaults', () => {
    expect(
      resolveClaudeToolAccess({ ...read, sourceApproval: 'prompt' }, { permissionMode: 'bypassPermissions' }).approval
    ).toBe('prompt')
  })

  it('applies mode, safe, and manual defaults in order', () => {
    expect(resolveClaudeToolAccess(webSearch, { permissionMode: 'bypassPermissions' }).approval).toBe('auto')
    expect(resolveClaudeToolAccess(edit, { permissionMode: 'acceptEdits' }).approval).toBe('auto')
    expect(resolveClaudeToolAccess(read, {}).approval).toBe('auto')
    expect(resolveClaudeToolAccess(webSearch, {}).approval).toBe('prompt')
  })

  it('treats auto mode as default — the SDK classifier decides, so nothing is pre-approved', () => {
    expect(resolveClaudeToolAccess(read, { permissionMode: 'auto' }).approval).toBe('auto')
    expect(resolveClaudeToolAccess(edit, { permissionMode: 'auto' }).approval).toBe('prompt')
    expect(resolveClaudeToolAccess(webSearch, { permissionMode: 'auto' }).approval).toBe('prompt')
  })

  it('applies invocation-level acceptEdits Bash defaults', () => {
    const bash: ClaudeToolDescriptor = {
      id: 'Bash',
      name: 'Bash',
      origin: 'builtin'
    }

    expect(
      resolveClaudeToolInvocationAccess(
        bash,
        { permissionMode: 'acceptEdits' },
        { toolName: 'Bash', input: { command: 'mkdir tmp' } }
      ).approval
    ).toBe('auto')
    expect(
      resolveClaudeToolInvocationAccess(
        bash,
        { permissionMode: 'acceptEdits' },
        { toolName: 'Bash', input: { command: 'curl example.com' } }
      ).approval
    ).toBe('prompt')
  })
})
