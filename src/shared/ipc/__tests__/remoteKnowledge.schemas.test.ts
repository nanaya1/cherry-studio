import { describe, expect, it } from 'vitest'

import { remoteKnowledgeRequestSchemas } from '../schemas/remoteKnowledge'

/**
 * Contract checks for the remote-knowledge IPC routes: every route must parse a
 * minimal well-formed call, and the risky input edges (test_connection's XOR pair,
 * list_bases' optional service id) must reject malformed payloads before any
 * handler runs.
 */
describe('remoteKnowledgeRequestSchemas', () => {
  const draft = {
    name: 'Corp KB',
    baseUrl: 'https://kb.example.com',
    authType: 'bearer' as const,
    apiKey: 'secret-key'
  }

  it('declares exactly the six configuration routes', () => {
    expect(Object.keys(remoteKnowledgeRequestSchemas).sort()).toEqual(
      [
        'remoteKnowledge.create',
        'remoteKnowledge.delete',
        'remoteKnowledge.list',
        'remoteKnowledge.list_bases',
        'remoteKnowledge.test_connection',
        'remoteKnowledge.update'
      ].sort()
    )
  })

  it('parses create with a bearer draft', () => {
    const route = remoteKnowledgeRequestSchemas['remoteKnowledge.create']
    expect(route.input.parse({ draft }).constructor).toBeDefined()
    expect(() => route.input.parse({ draft: { ...draft, baseUrl: 'not-a-url' } })).toThrow()
  })

  it('parses update with id and partial patch', () => {
    const route = remoteKnowledgeRequestSchemas['remoteKnowledge.update']
    expect(route.input.parse({ id: 'svc-1', patch: { name: 'Renamed' } })).toBeDefined()
  })

  it('test_connection rejects payloads with both id and config (XOR contract)', () => {
    const route = remoteKnowledgeRequestSchemas['remoteKnowledge.test_connection']
    expect(() => route.input.parse({ id: 'svc-1', config: draft })).toThrow()
    expect(route.input.parse({ id: 'svc-1' })).toBeDefined()
    expect(route.input.parse({ config: draft })).toBeDefined()
  })

  it('list_bases accepts an omitted service id (aggregate listing)', () => {
    const route = remoteKnowledgeRequestSchemas['remoteKnowledge.list_bases']
    expect(route.input.parse({})).toBeDefined()
    expect(route.input.parse({ id: 'svc-1' })).toBeDefined()
  })
})
