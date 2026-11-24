import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import { useTabs } from '@renderer/hooks/tab'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { publishIndustrialVideoDelivery } from '@renderer/services/industrialVideoDeliveryStore'
import { toast } from '@renderer/services/toast'
import { findConversationTab } from '@renderer/utils/conversationNavigation'

const logger = loggerService.withContext('ConversationNotificationRuntime')

/** Foreground-only presentation of main-prepared conversation notifications. */
export function ConversationNotificationRuntime(): null {
  const { activeTab } = useTabs()
  const { t } = useTranslation()

  useIpcOn('notification.conversation', (notification) => {
    if (activeTab && findConversationTab([activeTab], notification.meta)) return

    const showToast = notification.kind === 'task-completion' ? toast.success : toast.warning
    const openConversation = () => {
      toast.closeToast(notification.id)
      void ipcApi
        .request('navigation.focus_or_open_conversation', {
          target: notification.meta,
          title: notification.message
        })
        .catch((error) => logger.error('Failed to open conversation from notification', error as Error))
    }
    const isIndustrialVideo = notification.id.startsWith('industrial-video-completion:')
    showToast({
      key: notification.id,
      title: isIndustrialVideo ? t('industrial_video.orchestration.complete') : notification.title,
      description: notification.message,
      timeout: 6000,
      onClick: openConversation,
      action: isIndustrialVideo ? { label: t('industrial_video.preview.expand'), onClick: openConversation } : undefined
    })
  })
  useIpcOn('industrial_video.delivery_updated', ({ sessionId, unread }) => {
    publishIndustrialVideoDelivery(sessionId, unread)
  })

  return null
}
