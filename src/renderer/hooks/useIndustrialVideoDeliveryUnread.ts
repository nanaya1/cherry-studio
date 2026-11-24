import { useSyncExternalStore } from 'react'

import {
  getIndustrialVideoDeliveryUnread,
  subscribeIndustrialVideoDelivery
} from '@renderer/services/industrialVideoDeliveryStore'

export function useIndustrialVideoDeliveryUnread(sessionId: string | undefined): boolean {
  return useSyncExternalStore(subscribeIndustrialVideoDelivery, () => getIndustrialVideoDeliveryUnread(sessionId))
}
