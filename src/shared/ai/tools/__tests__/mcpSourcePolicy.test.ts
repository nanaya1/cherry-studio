import { describe, expect, it } from 'vitest'

import type { McpServer } from '../../../data/types/mcpServer'
import {
  isMcpToolDisabledBySource,
  isMcpToolForcePromptBySource,
  matchesMcpSourceToolRule,
  resolveMcpSourceToolAccess
} from '../mcpSourcePolicy'

const server = {
  id: 'docs-id',
  name: 'docs',
  isActive: true,
  disabledTools: [],
  disabledAutoApproveTools: []
} as McpServer

const tool = {
  id: 'mcp__docs__searchDocs_0123456789abcdefabcd',
  name: 'search_docs'
}

describe('mcpSourcePolicy', () => {
  it('matches raw name, current id, legacy id, and server wildcard', () => {
    expect(matchesMcpSourceToolRule('search_docs', server, tool)).toBe(true)
    expect(matchesMcpSourceToolRule(tool.id, server, tool)).toBe(true)
    expect(matchesMcpSourceToolRule('mcp__docs__searchDocs', server, tool)).toBe(true)
    expect(matchesMcpSourceToolRule('mcp__docs__*', server, tool)).toBe(true)
    expect(matchesMcpSourceToolRule('mcp__other__searchDocs', server, tool)).toBe(false)
  })

  it('resolves disabled before force prompt', () => {
    const configured = {
      ...server,
      disabledTools: ['search_docs'],
      disabledAutoApproveTools: ['mcp__docs__searchDocs']
    } as McpServer

    expect(isMcpToolDisabledBySource(configured, tool)).toBe(true)
    expect(isMcpToolForcePromptBySource(configured, tool)).toBe(true)
    expect(resolveMcpSourceToolAccess(configured, tool)).toEqual({ enabled: false, approval: 'prompt' })
  })

  it('resolves source force-prompt for auto-approval opt-out', () => {
    expect(resolveMcpSourceToolAccess({ ...server, disabledAutoApproveTools: ['search_docs'] }, tool)).toEqual({
      enabled: true,
      approval: 'prompt'
    })
  })

  it('matches builtin-tools rules persisted under the legacy server id after the rename', () => {
    // The in-process builtin server is now `meacowork-tools`, but an agent's persisted
    // disabledTools / disabledAutoApproveTools may still carry the pre-rename wire ids.
    const builtinServer = { ...server, name: 'meacowork-tools' }
    const builtinTool = { name: 'web_search' }
    // source-policy rules are minted by buildFunctionCallToolName → camelCase segments.
    expect(matchesMcpSourceToolRule('mcp__meacoworkTools__webSearch', builtinServer, builtinTool)).toBe(true)
    expect(matchesMcpSourceToolRule('mcp__cherryTools__webSearch', builtinServer, builtinTool)).toBe(true)
    expect(matchesMcpSourceToolRule('mcp__cherryTools__*', builtinServer, builtinTool)).toBe(true)
    // A different server's rule must never match just because the tool name is shared.
    expect(matchesMcpSourceToolRule('mcp__docs__webSearch', builtinServer, builtinTool)).toBe(false)
  })

  it('applies legacy disabled rules to the renamed builtin server', () => {
    const builtinServer = { ...server, name: 'meacowork-tools' }
    const builtinTool = { name: 'kb_manage' }
    const configured = { ...builtinServer, disabledTools: ['mcp__cherryTools__kbManage'] } as McpServer
    expect(isMcpToolDisabledBySource(configured, builtinTool)).toBe(true)
  })
})
