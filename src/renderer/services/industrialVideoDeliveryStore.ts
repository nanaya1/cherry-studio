const unreadDeliveries = new Map<string, boolean>()
const listeners = new Set<() => void>()

export function publishIndustrialVideoDelivery(sessionId: string, unread: boolean): void {
  if (unread) unreadDeliveries.set(sessionId, true)
  else unreadDeliveries.delete(sessionId)
  listeners.forEach((listener) => listener())
}

export function subscribeIndustrialVideoDelivery(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getIndustrialVideoDeliveryUnread(sessionId: string | undefined): boolean {
  return Boolean(sessionId && unreadDeliveries.get(sessionId))
}
