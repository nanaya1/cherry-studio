import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    net: { fetch: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((plaintext: string) => Buffer.from(`enc:${plaintext}`)),
      // Real decryptString returns a utf8 string, not a Buffer (Electron types)
      decryptString: vi.fn((encrypted: Buffer) => encrypted.toString('utf8').replace(/^enc:/, ''))
    }
  }
})

import { setupTestDatabase } from '@test-helpers/db'

import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import {
  agentRemoteKnowledgeBaseTable,
  assistantRemoteKnowledgeBaseTable,
  remoteKnowledgeServiceTable
} from '@data/db/schemas/remoteKnowledge'
import { BaseService } from '@main/core/lifecycle'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { buildRemoteKnowledgeBaseId, type RemoteServiceDraft } from '@shared/data/types/remoteKnowledge'

import { RemoteKnowledgeService } from '../RemoteKnowledgeService'

const { net, safeStorage } = await import('electron')
const netFetchMock = vi.mocked(net.fetch)
const encryptStringMock = vi.mocked(safeStorage.encryptString)

const draft = (overrides: Partial<RemoteServiceDraft> = {}): RemoteServiceDraft => ({
  name: 'Corp KB',
  baseUrl: 'https://kb.example.com',
  authType: 'bearer',
  apiKey: 'secret-key',
  timeoutMs: 30_000,
  enabled: true,
  ...overrides
})

describe('RemoteKnowledgeService', () => {
  const dbh = setupTestDatabase()
  let service: RemoteKnowledgeService

  async function seedAssistant(id: string) {
    await dbh.db.insert(assistantTable).values({
      id,
      name: 'assistant',
      emoji: '🌟',
      orderKey: 'a0',
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
  }

  async function seedAgent(id: string) {
    await dbh.db.insert(agentTable).values({
      id,
      type: 'claude-code',
      name: 'agent',
      instructions: '',
      orderKey: 'a0'
    })
  }

  beforeEach(() => {
    BaseService.resetInstances()
    service = new RemoteKnowledgeService()
    netFetchMock.mockReset()
  })

  afterEach(() => {
    BaseService.resetInstances()
  })

  describe('create', () => {
    it('encrypts the api key; plaintext never reaches the DB', async () => {
      const info = service.create(draft({ authType: 'bearer', apiKey: 'my-plain-key' }))

      expect(info.hasApiKey).toBe(true)
      const [row] = dbh.db
        .select()
        .from(remoteKnowledgeServiceTable)
        .where(eq(remoteKnowledgeServiceTable.id, info.id))
        .all()
      expect(row.apiKeyEncrypted).toBeDefined()
      expect(row.apiKeyEncrypted).not.toBe('my-plain-key')
    })

    it('persists a service without an api key', async () => {
      const info = service.create(draft({ authType: 'api_key', apiKey: undefined }))

      expect(info.hasApiKey).toBe(false)
      const [row] = dbh.db
        .select()
        .from(remoteKnowledgeServiceTable)
        .where(eq(remoteKnowledgeServiceTable.id, info.id))
        .all()
      expect(row.apiKeyEncrypted).toBeNull()
    })

    it('rejects oauth2 with invalid_request', async () => {
      expect(() => service.create(draft({ authType: 'oauth2' }))).toThrowError(/oauth2/i)
    })

    it('rejects a malformed baseUrl', () => {
      expect(() => service.create(draft({ baseUrl: 'not-a-url' }))).toThrowError()
    })
  })

  describe('list / getById', () => {
    it('returns hasApiKey without any key material in the DTO', async () => {
      const created = service.create(draft())
      service.create(draft({ name: 'No Key', apiKey: undefined }))

      const all = service.list()
      expect(all).toHaveLength(2)

      const withKey = all.find((s) => s.id === created.id)!
      expect(withKey.hasApiKey).toBe(true)
      expect(JSON.stringify(withKey)).not.toContain('secret-key')
      expect(JSON.stringify(withKey)).not.toContain('apiKeyEncrypted')

      expect(service.getById(created.id).name).toBe('Corp KB')
    })

    it('getById throws NOT_FOUND for unknown id', () => {
      expect(() => service.getById('missing-id')).toThrowError(/not found/i)
    })
  })

  describe('update', () => {
    it('re-encrypts when a new api key is provided', async () => {
      const created = service.create(draft({ apiKey: 'old-key' }))
      service.update(created.id, { apiKey: 'new-key', name: 'Renamed' })

      const [row] = dbh.db
        .select()
        .from(remoteKnowledgeServiceTable)
        .where(eq(remoteKnowledgeServiceTable.id, created.id))
        .all()
      expect(row.apiKeyEncrypted).not.toContain('old-key')
      expect(row.name).toBe('Renamed')
    })

    it('keeps the stored key when apiKey is omitted', async () => {
      const created = service.create(draft({ apiKey: 'keep-me' }))
      encryptStringMock.mockClear()

      service.update(created.id, { name: 'Only Rename' })

      expect(encryptStringMock).not.toHaveBeenCalled()
      expect(service.getById(created.id).hasApiKey).toBe(true)
    })

    it('can clear the key with an empty string', () => {
      const created = service.create(draft({ apiKey: 'doomed' }))
      service.update(created.id, { apiKey: '' })

      expect(service.getById(created.id).hasApiKey).toBe(false)
    })

    it('rejects switching authType to oauth2', () => {
      const created = service.create(draft())
      expect(() => service.update(created.id, { authType: 'oauth2' })).toThrowError(/oauth2/i)
    })

    it('throws NOT_FOUND for unknown id', () => {
      expect(() => service.update('missing-id', { name: 'x' })).toThrowError(/not found/i)
    })
  })

  describe('delete', () => {
    it('removes the row and cascades binding cleanup in both junction tables', async () => {
      await seedAssistant('asst-1')
      await seedAgent('agent-1')
      const created = service.create(draft())
      const remoteId = buildRemoteKnowledgeBaseId(created.id, 'base/1')
      // A binding to another service id must survive this service's delete.
      const otherServiceId = buildRemoteKnowledgeBaseId('svc-other', 'b')

      await dbh.db.insert(agentRemoteKnowledgeBaseTable).values([
        { agentId: 'agent-1', remoteBaseId: remoteId },
        { agentId: 'agent-1', remoteBaseId: otherServiceId }
      ])
      await dbh.db.insert(assistantRemoteKnowledgeBaseTable).values({ assistantId: 'asst-1', remoteBaseId: remoteId })

      service.delete(created.id)

      expect(service.list()).toHaveLength(0)
      const remainingAgentRows = dbh.db.select().from(agentRemoteKnowledgeBaseTable).all()
      expect(remainingAgentRows.map((r) => r.remoteBaseId)).toEqual([otherServiceId])
      const remainingAssistantRows = dbh.db.select().from(assistantRemoteKnowledgeBaseTable).all()
      expect(remainingAssistantRows).toHaveLength(0)
    })

    it('throws NOT_FOUND for unknown id', () => {
      expect(() => service.delete('missing-id')).toThrowError(/not found/i)
    })
  })

  describe('hasAnyEnabledService', () => {
    it('is false with no rows', () => {
      expect(service.hasAnyEnabledService()).toBe(false)
    })

    it('is false when every service is disabled', () => {
      service.create(draft({ enabled: false }))
      expect(service.hasAnyEnabledService()).toBe(false)
    })

    it('is true when at least one service is enabled', () => {
      service.create(draft({ enabled: false }))
      service.create(draft({ enabled: true }))
      expect(service.hasAnyEnabledService()).toBe(true)
    })
  })

  describe('resolveClientConfig', () => {
    it('decrypts the api key round-trip', () => {
      const created = service.create(draft({ apiKey: 'round-trip-key' }))
      const config = service.resolveClientConfig(created.id)

      expect(config.id).toBe(created.id)
      expect(config.apiKey).toBe('round-trip-key')
      expect(config.baseUrl).toBe('https://kb.example.com')
    })

    it('throws NOT_FOUND for unknown or disabled service', () => {
      const created = service.create(draft({ enabled: false }))
      expect(() => service.resolveClientConfig('missing-id')).toThrowError(/not found/i)
      expect(() => service.resolveClientConfig(created.id)).toThrowError(/not found|disabled/i)
    })
  })

  describe('listRemoteBases', () => {
    it('maps remote bases to composite ids for one service', async () => {
      const created = service.create(draft())
      netFetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            bases: [
              { id: 'b1', name: 'Base One', document_count: 2 },
              { id: 'b2', name: 'B2', description: 'd' }
            ]
          }),
          {
            status: 200
          }
        )
      )

      const bases = await service.listRemoteBases(created.id)
      expect(bases.map((b) => b.id)).toEqual([
        buildRemoteKnowledgeBaseId(created.id, 'b1'),
        buildRemoteKnowledgeBaseId(created.id, 'b2')
      ])
      expect(bases[0]).toMatchObject({ serviceName: 'Corp KB', documentCount: 2 })
      expect(bases[1].documentCount).toBeUndefined()
    })

    it('aggregates across all enabled services when serviceId is omitted', async () => {
      const enabled = service.create(draft({ name: 'Enabled' }))
      service.create(draft({ name: 'Disabled', enabled: false }))
      netFetchMock.mockResolvedValue(new Response(JSON.stringify({ bases: [{ id: 'x', name: 'X' }] }), { status: 200 }))

      const bases = await service.listRemoteBases()
      expect(bases.map((b) => b.serviceId)).toEqual([enabled.id])
    })

    it('returns [] when there are no services', async () => {
      await expect(service.listRemoteBases()).resolves.toEqual([])
    })
  })

  describe('testConnection', () => {
    it('returns ok + latency for a saved service', async () => {
      const created = service.create(draft())
      netFetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))

      const result = await service.testConnection({ id: created.id })
      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      expect(result.error).toBeUndefined()
    })

    it('tests an unsaved draft without persisting it', async () => {
      netFetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))

      const result = await service.testConnection({ config: draft({ apiKey: 'draft-key' }) })
      expect(result.ok).toBe(true)
      expect(service.list()).toHaveLength(0)
    })

    it('reports failures as data (ok:false + error), not throws', async () => {
      const created = service.create(draft())
      netFetchMock.mockRejectedValue(new Error('request_timeout: timed out'))

      const result = await service.testConnection({ id: created.id })
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    })

    it('rejects oauth2 drafts as unsupported', async () => {
      const result = await service.testConnection({ config: draft({ authType: 'oauth2' }) })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/oauth2|不支持/i)
    })

    it('requires exactly one of id or config', async () => {
      await expect(service.testConnection({})).rejects.toThrowError()
      await expect(service.testConnection({ id: 'x', config: draft() })).rejects.toThrowError()
    })
  })
})
