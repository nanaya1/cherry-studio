import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrgKnowledgeCatalog } from '@shared/data/types/enterpriseKnowledge'
import type { KnowledgeBase } from '@shared/data/types/knowledge'

import { useComposerKnowledgeBaseScope } from '../useComposerKnowledgeBaseScope'

const org = vi.hoisted(() => ({
  catalog: {
    public: [],
    shared: [],
    owned: []
  } as OrgKnowledgeCatalog,
  loading: false
}))
vi.mock('@renderer/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => org }))

const kb = (id: string, name = id): KnowledgeBase => ({ id, name }) as KnowledgeBase

interface HarnessProps {
  configuredKnowledgeBaseIds?: readonly string[]
  allKnowledgeBases: KnowledgeBase[]
  isKnowledgeBasesLoading: boolean
  scopeKey: string
  initialSelection?: KnowledgeBase[]
  remountsOnScopeChange?: boolean
}

/** Drives the hook with real selection state so pruning and restore effects actually settle. */
function useScopeHarness(props: HarnessProps) {
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<KnowledgeBase[]>(props.initialSelection ?? [])
  const scope = useComposerKnowledgeBaseScope({
    configuredKnowledgeBaseIds: props.configuredKnowledgeBaseIds,
    allKnowledgeBases: props.allKnowledgeBases,
    isKnowledgeBasesLoading: props.isKnowledgeBasesLoading,
    scopeKey: props.scopeKey,
    selectedKnowledgeBases,
    setSelectedKnowledgeBases,
    remountsOnScopeChange: props.remountsOnScopeChange
  })
  return { ...scope, selectedKnowledgeBases }
}

const SCOPE_KEY = 'topic-1:agent-1'

describe('useComposerKnowledgeBaseScope', () => {
  beforeEach(() => {
    org.catalog = { public: [], shared: [], owned: [] }
    org.loading = false
  })

  it('支持本人云端库标记和选择恢复，并保留配置范围与账号切换清理', () => {
    const owned = { id: 'orgkb:b3duZWQ', name: '本人云端库', description: null, documentCount: 2 }
    const excluded = { ...owned, id: 'orgkb:b3RoZXI', name: '未配置云端库' }
    org.catalog = { public: [], shared: [], owned: [owned, excluded] }
    const props = {
      configuredKnowledgeBaseIds: [owned.id],
      allKnowledgeBases: [],
      isKnowledgeBasesLoading: false,
      scopeKey: SCOPE_KEY
    }
    const { result, rerender } = renderHook(useScopeHarness, { initialProps: props })

    expect(result.current.selectableKnowledgeBases.map((base) => base.id)).toEqual([owned.id])
    expect(result.current.resolveKnowledgeBaseMarker(owned.id)).toMatchObject({ kind: 'knowledge' })
    expect(result.current.resolveKnowledgeBaseMarker(owned.name)).toMatchObject({ kind: 'knowledge' })
    expect(result.current.resolveKnowledgeBaseMarker(excluded.id)).toBeNull()
    act(() => result.current.restoreKnowledgeBaseSelection([owned.id, excluded.id]))
    expect(result.current.selectedKnowledgeBasesInScope.map((base) => base.id)).toEqual([owned.id])

    org.catalog = { public: [], shared: [], owned: [] }
    rerender(props)
    expect(result.current.selectedKnowledgeBases).toEqual([])
    expect(result.current.resolveKnowledgeBaseMarker(owned.id)).toBeNull()
  })

  it('解析组织库标记，并在账号目录清空时立即移除旧选择', () => {
    const base = { id: 'orgkb:b25l', name: '组织库', description: null, documentCount: 2 }
    org.catalog = { public: [base], shared: [], owned: [] }
    const { result, rerender } = renderHook(useScopeHarness, {
      initialProps: {
        allKnowledgeBases: [],
        isKnowledgeBasesLoading: true,
        scopeKey: SCOPE_KEY,
        initialSelection: [kb(base.id)],
        remountsOnScopeChange: true
      }
    })
    expect(result.current.resolveKnowledgeBaseMarker(base.id)).toMatchObject({ kind: 'knowledge' })
    expect(result.current.selectedKnowledgeBasesInScope.map((item) => item.id)).toEqual([base.id])
    org.catalog = { public: [], shared: [], owned: [] }
    org.loading = true
    rerender({
      allKnowledgeBases: [],
      isKnowledgeBasesLoading: true,
      scopeKey: SCOPE_KEY,
      initialSelection: [kb(base.id)],
      remountsOnScopeChange: true
    })
    expect(result.current.selectedKnowledgeBasesInScope).toEqual([])
    expect(result.current.selectedKnowledgeBases).toEqual([])
    org.loading = false
  })

  it('treats an empty configured knowledge-base list as all loaded bases selectable', () => {
    const bases = [kb('kb-1', 'Knowledge One'), kb('kb-2', 'Knowledge Two')]

    const { result, rerender } = renderHook(() =>
      useComposerKnowledgeBaseScope({
        configuredKnowledgeBaseIds: [],
        allKnowledgeBases: bases,
        isKnowledgeBasesLoading: false,
        scopeKey: SCOPE_KEY,
        selectedKnowledgeBases: [bases[0]],
        setSelectedKnowledgeBases: vi.fn()
      })
    )

    expect(result.current.selectableKnowledgeBases).toEqual(bases)
    rerender()
    expect(result.current.selectedKnowledgeBasesInScope).toEqual([bases[0]])
    expect(result.current.resolveKnowledgeBaseMarker('Knowledge Two')).toMatchObject({
      id: 'knowledge:kb-2',
      kind: 'knowledge'
    })
  })

  describe('restoreKnowledgeBaseSelection', () => {
    const bases = [kb('kb-1'), kb('kb-2')]

    it('re-selects the persisted ids once the bases have loaded', () => {
      const { result } = renderHook(useScopeHarness, {
        initialProps: { allKnowledgeBases: bases, isKnowledgeBasesLoading: false, scopeKey: SCOPE_KEY }
      })

      act(() => result.current.restoreKnowledgeBaseSelection(['kb-2']))

      expect(result.current.selectedKnowledgeBases).toEqual([bases[1]])
    })

    it('restores only ids the send path would accept', () => {
      // `selectableKnowledgeBases`, not the raw list: a queued payload naming a base the agent no
      // longer configures must not come back as a checked-but-unsendable pick.
      const { result } = renderHook(useScopeHarness, {
        initialProps: {
          configuredKnowledgeBaseIds: ['kb-1'],
          allKnowledgeBases: bases,
          isKnowledgeBasesLoading: false,
          scopeKey: SCOPE_KEY
        }
      })

      act(() => result.current.restoreKnowledgeBaseSelection(['kb-1', 'kb-2']))

      expect(result.current.selectedKnowledgeBases).toEqual([bases[0]])
    })
  })

  describe('remountsOnScopeChange', () => {
    const bases = [kb('kb-1'), kb('kb-2')]

    it('keeps a selection seeded at mount when the caller remounts per scope', () => {
      // The Agent composer restores its knowledge chips from the draft cache and must seed the pick
      // synchronously, or the surface's managed-token sync strips the chip as unselected. Its tool
      // provider is keyed by agent + session, so that seed can only belong to the current scope.
      const { result } = renderHook(useScopeHarness, {
        initialProps: {
          allKnowledgeBases: bases,
          isKnowledgeBasesLoading: false,
          scopeKey: SCOPE_KEY,
          initialSelection: [bases[0]],
          remountsOnScopeChange: true
        }
      })

      expect(result.current.selectedKnowledgeBases).toEqual([bases[0]])
      expect(result.current.selectedKnowledgeBasesInScope).toEqual([bases[0]])
    })

    it('still prunes a seeded pick the assistant no longer configures', () => {
      const { result } = renderHook(useScopeHarness, {
        initialProps: {
          configuredKnowledgeBaseIds: ['kb-2'],
          allKnowledgeBases: bases,
          isKnowledgeBasesLoading: false,
          scopeKey: SCOPE_KEY,
          initialSelection: [bases[0]],
          remountsOnScopeChange: true
        }
      })

      expect(result.current.selectedKnowledgeBases).toEqual([])
    })

    it('clears a mount selection when the caller shares one hook across scopes', () => {
      // Chat keeps a single tool provider across topics, so a selection present at mount predates the
      // current scope and must not survive into it.
      const { result } = renderHook(useScopeHarness, {
        initialProps: {
          allKnowledgeBases: bases,
          isKnowledgeBasesLoading: false,
          scopeKey: SCOPE_KEY,
          initialSelection: [bases[0]]
        }
      })

      expect(result.current.selectedKnowledgeBases).toEqual([])
    })
  })

  it('clears the selection when the composer scope key changes', () => {
    const bases = [kb('kb-1'), kb('kb-2')]
    const { result, rerender } = renderHook(useScopeHarness, {
      initialProps: { allKnowledgeBases: bases, isKnowledgeBasesLoading: false, scopeKey: SCOPE_KEY }
    })
    act(() => result.current.restoreKnowledgeBaseSelection(['kb-1']))
    expect(result.current.selectedKnowledgeBases).toEqual([bases[0]])

    // Switching topic or agent must not carry one conversation's knowledge scope into the next.
    rerender({ allKnowledgeBases: bases, isKnowledgeBasesLoading: false, scopeKey: 'topic-2:agent-1' })

    expect(result.current.selectedKnowledgeBases).toEqual([])
  })
})
