import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { SWRConfig } from 'swr'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteKnowledgeServiceInfo } from '@shared/data/types/remoteKnowledge'

import { useRemoteKnowledgeBases, useRemoteKnowledgeServices } from '../useRemoteKnowledge'

const ipcRequest = vi.fn()
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: (...args: unknown[]) => ipcRequest(...args) } }))

const service: RemoteKnowledgeServiceInfo = {
  id: 'service-1',
  name: 'Remote',
  baseUrl: 'https://example.com',
  authType: 'bearer',
  timeoutMs: 30_000,
  enabled: true,
  hasApiKey: true,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z'
}

const wrapper = ({ children }: PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
)

describe('useRemoteKnowledge', () => {
  beforeEach(() => {
    ipcRequest.mockReset()
  })

  it('loads services and refreshes after create', async () => {
    ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'remoteKnowledge.list') return [service]
      if (route === 'remoteKnowledge.create') return service
      return []
    })
    const { result } = renderHook(() => useRemoteKnowledgeServices(), { wrapper })

    await waitFor(() => expect(result.current.services).toEqual([service]))
    await act(async () => {
      await result.current.createService({
        name: 'Remote',
        baseUrl: 'https://example.com',
        authType: 'bearer'
      })
    })

    expect(ipcRequest).toHaveBeenCalledWith('remoteKnowledge.create', {
      draft: { name: 'Remote', baseUrl: 'https://example.com', authType: 'bearer' }
    })
    expect(ipcRequest.mock.calls.filter(([route]) => route === 'remoteKnowledge.list')).toHaveLength(2)
  })

  it('passes update, delete, and test-connection payloads without treating probe failures as throws', async () => {
    ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'remoteKnowledge.list') return [service]
      if (route === 'remoteKnowledge.update') return { ...service, enabled: false }
      if (route === 'remoteKnowledge.test_connection') return { ok: false, error: 'unauthorized' }
      return undefined
    })
    const { result } = renderHook(() => useRemoteKnowledgeServices(), { wrapper })
    await waitFor(() => expect(result.current.services).toHaveLength(1))

    await act(async () => {
      await result.current.updateService(service.id, { enabled: false })
      expect(await result.current.testConnection({ id: service.id })).toEqual({ ok: false, error: 'unauthorized' })
      await result.current.deleteService(service.id)
    })

    expect(ipcRequest).toHaveBeenCalledWith('remoteKnowledge.update', {
      id: service.id,
      patch: { enabled: false }
    })
    expect(ipcRequest).toHaveBeenCalledWith('remoteKnowledge.test_connection', { id: service.id })
    expect(ipcRequest).toHaveBeenCalledWith('remoteKnowledge.delete', { id: service.id })
  })

  it('loads all bases with the required empty input object', async () => {
    const bases = [
      {
        id: 'remote:service-1:base-1',
        serviceId: 'service-1',
        serviceName: 'Remote',
        remoteBaseId: 'base-1',
        name: 'Docs'
      }
    ]
    ipcRequest.mockResolvedValue(bases)

    const { result } = renderHook(() => useRemoteKnowledgeBases(), { wrapper })

    await waitFor(() => expect(result.current.bases).toEqual(bases))
    expect(ipcRequest).toHaveBeenCalledWith('remoteKnowledge.list_bases', {})
  })
})
