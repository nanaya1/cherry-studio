import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import type { RemoteKnowledgeBaseInfo } from '@shared/data/types/remoteKnowledge'

import {
  mergeSelectableKnowledgeBases,
  projectRemoteKnowledgeBase,
  useSelectableKnowledgeBases
} from '../useSelectableKnowledgeBases'

const remoteBase: RemoteKnowledgeBaseInfo = {
  id: 'remote:service-1:docs',
  serviceId: 'service-1',
  serviceName: 'Remote Service',
  remoteBaseId: 'docs',
  name: 'Remote Docs'
}

const localBase = {
  id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  name: 'Local Docs',
  groupId: null,
  dimensions: null,
  embeddingModelId: null,
  status: 'completed',
  error: null,
  chunkSize: 1024,
  chunkOverlap: 200,
  chunkStrategy: 'structured',
  chunkSeparator: '\\n\\n',
  itemCount: 3
} as KnowledgeBaseListItem

describe('projectRemoteKnowledgeBase', () => {
  it('projects a remote base into a read-only KnowledgeBaseListItem shape', () => {
    const projected = projectRemoteKnowledgeBase(remoteBase)

    expect(projected).toMatchObject({
      id: 'remote:service-1:docs',
      name: 'Remote Docs',
      status: 'completed',
      error: null,
      itemCount: 0,
      documentCount: 0
    })
  })

  it('keeps the BM25-only invariant pairing (embeddingModelId and dimensions both null)', () => {
    const projected = projectRemoteKnowledgeBase(remoteBase)

    expect(projected.embeddingModelId).toBeNull()
    expect(projected.dimensions).toBeNull()
    expect(projected.chunkOverlap).toBeLessThan(projected.chunkSize)
  })
})

describe('useSelectableKnowledgeBases', () => {
  it('keeps the merged reference stable while both source references are unchanged', () => {
    const localBases = [localBase]
    const remoteBases = [remoteBase]
    const { result, rerender } = renderHook(({ local, remote }) => useSelectableKnowledgeBases(local, remote), {
      initialProps: { local: localBases, remote: remoteBases }
    })
    const initial = result.current

    rerender({ local: localBases, remote: remoteBases })

    expect(result.current).toBe(initial)
  })

  it('rebuilds the merged result when either source reference changes', () => {
    const localBases = [localBase]
    const remoteBases = [remoteBase]
    const { result, rerender } = renderHook(({ local, remote }) => useSelectableKnowledgeBases(local, remote), {
      initialProps: { local: localBases, remote: remoteBases }
    })
    const initial = result.current

    rerender({ local: [...localBases], remote: remoteBases })

    expect(result.current).not.toBe(initial)
  })
})

describe('mergeSelectableKnowledgeBases', () => {
  it('places local bases first and remote projections after', () => {
    const merged = mergeSelectableKnowledgeBases([localBase], [remoteBase])

    expect(merged.map((base) => base.id)).toEqual(['6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'remote:service-1:docs'])
    expect(merged[1].name).toBe('Remote Docs')
  })

  it('returns an empty array when both sources are empty', () => {
    expect(mergeSelectableKnowledgeBases([], [])).toEqual([])
  })
})
