import { getFileExt } from '@main/utils/legacyFile'
import type { KnowledgeBase } from '@shared/data/types/knowledge'
import type { KnowledgeItem } from '@shared/data/types/knowledge'
import { knowledgeFileProcessingExts } from '@shared/utils/file'

import { isContainerKnowledgeItem, isIndexableKnowledgeItem } from '../../items'

const KNOWLEDGE_FILE_PROCESSING_EXT_SET = new Set<string>(knowledgeFileProcessingExts)

export type KnowledgeSourcePlan =
  | { kind: 'prepare-root' }
  | { kind: 'index-documents' }
  | { kind: 'needsFileProcessing'; processorId: string }
  | { kind: 'invalid'; reason: string }

export type KnowledgeSourcePlanOptions = {
  /**
   * A reindex just re-copied the user's original over this file, so its processed artifact is stale
   * — run the processor again even though the item is already pinned to one.
   */
  forceFileReprocess?: boolean
}

export function planKnowledgeItemSource(
  base: KnowledgeBase,
  item: KnowledgeItem,
  options: KnowledgeSourcePlanOptions = {}
): KnowledgeSourcePlan {
  if (isContainerKnowledgeItem(item)) {
    return { kind: 'prepare-root' }
  }

  const processorId = needsFileProcessing(base, item, options)
  if (processorId) {
    return { kind: 'needsFileProcessing', processorId }
  }

  if (isIndexableKnowledgeItem(item)) {
    return { kind: 'index-documents' }
  }

  return { kind: 'invalid', reason: 'Unsupported knowledge item type' }
}

function needsFileProcessing(
  base: KnowledgeBase,
  item: KnowledgeItem,
  options: KnowledgeSourcePlanOptions
): string | null {
  // 原逻辑仅在知识库显式配置处理器时进入文件处理。
  // if (item.type !== 'file' || !base.fileProcessorId) return false
  if (item.type !== 'file') {
    return null
  }

  const ext = getFileExt(item.data.relativePath).toLowerCase()
  const processorId = base.fileProcessorId ?? (ext === '.pdf' ? 'local-document' : null)
  if (!processorId) {
    return null
  }

  // A file that already carries its processed artifact — restored from another base,
  // or already processed once — indexes straight from it; do not reprocess.
  if (item.data.indexedRelativePath && !options.forceFileReprocess) {
    return null
  }

  if (!KNOWLEDGE_FILE_PROCESSING_EXT_SET.has(ext)) {
    return null
  }

  return processorId
}
