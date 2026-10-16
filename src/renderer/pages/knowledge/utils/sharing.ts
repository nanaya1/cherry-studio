import type { OrgKnowledgePreview, OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'

export function parseRecipientId(value: string): number | null {
  const trimmed = value.trim()
  const id = Number(trimmed)
  return /^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(id) ? id : null
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
