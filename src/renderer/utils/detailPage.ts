import { CONVERSATION_ROUTES } from '@shared/utils/conversationRoute'

/**
 * Detail pages (a specific conversation) hide the in-shell conversation list
 * and its expand/collapse toggle. List routes without a key (`/app/chat`,
 * `/app/agents`) keep them.
 */
export function isDetailPageUrl(url: string | undefined): boolean {
  if (!url) return false

  try {
    const parsedUrl = new URL(url, 'app://x')

    return Object.values(CONVERSATION_ROUTES).some(
      ({ path, keyParam }) => parsedUrl.pathname === path && parsedUrl.searchParams.get(keyParam)
    )
  } catch {
    return false
  }
}
