import { CONVERSATION_ROUTES } from '@shared/utils/conversationRoute'

/**
 * Detail pages (a specific conversation or a specific scheduled task) hide the
 * workspace sidebar: the page owns the full width. List routes without a key
 * (`/app/chat`, `/app/agents`, `/app/scheduled-tasks`) keep the sidebar.
 */
export function isDetailPageUrl(url: string | undefined): boolean {
  if (!url) return false

  try {
    const parsedUrl = new URL(url, 'app://x')

    for (const { path, keyParam } of Object.values(CONVERSATION_ROUTES)) {
      if (parsedUrl.pathname === path && parsedUrl.searchParams.get(keyParam)) return true
    }

    return parsedUrl.pathname.startsWith('/app/scheduled-tasks/')
  } catch {
    return false
  }
}
