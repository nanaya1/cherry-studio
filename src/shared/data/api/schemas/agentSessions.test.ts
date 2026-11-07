import { describe, expect, it } from 'vitest'

import { CreateAgentSessionSchema, ReuseOrCreateAgentSessionSchema, UpdateAgentSessionSchema } from './agentSessions'

describe('session feature classification boundary', () => {
  const target = { agentId: 'agent', workspace: { type: 'system' } }

  it('accepts existing callers and explicit video creation without changing ordinary DTOs', () => {
    expect(CreateAgentSessionSchema.parse({ ...target, name: '' })).toEqual({ ...target, name: '' })
    expect(CreateAgentSessionSchema.parse({ ...target, name: '', featureKind: 'industrial-video' }).featureKind).toBe(
      'industrial-video'
    )
    expect(ReuseOrCreateAgentSessionSchema.parse({ ...target, featureKind: 'industrial-video' }).featureKind).toBe(
      'industrial-video'
    )
  })

  it('rejects unknown classifications and prevents mutation through ordinary update', () => {
    expect(CreateAgentSessionSchema.safeParse({ ...target, name: '', featureKind: 'unknown' }).success).toBe(false)
    expect(ReuseOrCreateAgentSessionSchema.safeParse({ ...target, featureKind: 'unknown' }).success).toBe(false)
    expect(UpdateAgentSessionSchema.safeParse({ featureKind: 'general' }).success).toBe(false)
    expect(UpdateAgentSessionSchema.safeParse({ name: 'renamed', featureKind: 'general' }).success).toBe(false)
  })
})
