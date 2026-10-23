import type { OrgKnowledgePreview, OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'
import type { KnowledgeItem } from '@shared/data/types/knowledge'

export function parseRecipientId(value: string): number | null {
  const trimmed = value.trim()
  const id = Number(trimmed)
  return /^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(id) ? id : null
}

export function areKnowledgeItemsReady(
  items: Array<Pick<KnowledgeItem, 'status'>>,
  total: number,
  isLoading: boolean
): boolean {
  return !isLoading && items.length === total && total > 0 && items.every((item) => item.status === 'completed')
}

export function canInviteAfterShare(result: OrgKnowledgeShareResult): boolean {
  return (
    result.completion === 'completed' &&
    result.files.length > 0 &&
    result.files.every((file) => file.status === 'success')
  )
}

export async function inviteAfterShare(
  result: OrgKnowledgeShareResult,
  userId: number,
  invite: (input: { baseId: string; userId: number; expireDays: number }) => Promise<unknown>
): Promise<boolean> {
  if (!canInviteAfterShare(result)) return false
  await invite({ baseId: result.shareId, userId, expireDays: 7 })
  return true
}

export function previewText(preview: OrgKnowledgePreview): string | null {
  return preview.kind === 'text' ? preview.content : null
}
