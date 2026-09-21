import { useMemo } from 'react'

import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import {
  DEFAULT_KNOWLEDGE_BASE_CHUNK_OVERLAP,
  DEFAULT_KNOWLEDGE_BASE_CHUNK_SIZE,
  DEFAULT_KNOWLEDGE_CHUNK_SEPARATOR,
  DEFAULT_KNOWLEDGE_CHUNK_STRATEGY
} from '@shared/data/types/knowledge'
import type { RemoteKnowledgeBaseInfo } from '@shared/data/types/remoteKnowledge'

/**
 * Remote-knowledge → selectable-`KnowledgeBase` projection helpers (Task 12).
 *
 * The composer picker, the resource edit dialogs and the composer scope hook all
 * speak the existing `KnowledgeBase[]` contract. Remote bases are projected into
 * that shape as read-only stand-ins (real `remote:{serviceId}:{remoteBaseId}` id
 * + name, legal BM25-only defaults for everything else) so no consumer has to
 * grow a remote-aware branch. Remote rows never reach the local DB through this
 * path — persistence splits ids again via `isRemoteKnowledgeBaseId`.
 */

/**
 * Projects one remote base into a read-only `KnowledgeBaseListItem`.
 *
 * Defaults are the legal "BM25-only completed base" form (embeddingModelId and
 * dimensions both null, status completed, no error) so the projected row would
 * also satisfy `KnowledgeBaseSchema`'s cross-field invariants. `createdAt` /
 * `updatedAt` are empty strings: remote services expose no timestamps and no UI
 * renders them for knowledge picks.
 */
export function projectRemoteKnowledgeBase(base: RemoteKnowledgeBaseInfo): KnowledgeBaseListItem {
  return {
    id: base.id,
    name: base.name,
    groupId: null,
    dimensions: null,
    embeddingModelId: null,
    status: 'completed',
    error: null,
    chunkSize: DEFAULT_KNOWLEDGE_BASE_CHUNK_SIZE,
    chunkOverlap: DEFAULT_KNOWLEDGE_BASE_CHUNK_OVERLAP,
    chunkStrategy: DEFAULT_KNOWLEDGE_CHUNK_STRATEGY,
    chunkSeparator: DEFAULT_KNOWLEDGE_CHUNK_SEPARATOR,
    documentCount: 0,
    itemCount: base.documentCount ?? 0,
    createdAt: '',
    updatedAt: ''
  }
}

/**
 * Merges the local knowledge-base list with the remote list into one selectable
 * array. Local rows come first (existing ordering/tests), remote projections
 * after; ids cannot collide because remote ids always carry the `remote:`
 * prefix while local ids are UUIDs.
 */
export function mergeSelectableKnowledgeBases(
  localBases: readonly KnowledgeBaseListItem[],
  remoteBases: readonly RemoteKnowledgeBaseInfo[]
): KnowledgeBaseListItem[] {
  return [...localBases, ...remoteBases.map(projectRemoteKnowledgeBase)]
}

/**
 * React-facing merge that preserves the result reference until either source
 * changes. Consumers feed the result into effects and context updates, so an
 * unconditional array allocation can create a render -> effect -> state loop.
 */
export function useSelectableKnowledgeBases(
  localBases: readonly KnowledgeBaseListItem[],
  remoteBases: readonly RemoteKnowledgeBaseInfo[]
): KnowledgeBaseListItem[] {
  return useMemo(() => mergeSelectableKnowledgeBases(localBases, remoteBases), [localBases, remoteBases])
}
