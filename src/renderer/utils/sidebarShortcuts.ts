import {
  createSidebarShortcutId,
  SIDEBAR_FAVORITES,
  type SidebarFavorite,
  type SidebarShortcutItem,
  type SidebarShortcutTarget
} from '@shared/data/preference/preferenceTypes'

const sidebarAppIds = new Set<string>(SIDEBAR_FAVORITES)
type SidebarAppId = SidebarFavorite

function isSidebarAppId(value: string): value is SidebarAppId {
  return sidebarAppIds.has(value)
}

export const SIDEBAR_SHORTCUT_PROVIDER_IDS = {
  APP: 'core.app',
  MINI_APP: 'core.mini-app',
  AGENT: 'core.agent',
  ASSISTANT: 'core.assistant',
  KNOWLEDGE_BASE: 'core.knowledge-base',
  TOPIC: 'core.topic',
  AGENT_SESSION: 'core.agent-session',
  FILE_ENTRY: 'core.file-entry',
  CODE_CLI: 'core.code-cli'
} as const

const RETIRED_SIDEBAR_SHORTCUT_PROVIDER_IDS = new Set(['core.skill', 'core.mcp-server', 'core.provider'])

export function createSidebarShortcutTarget(
  providerId: string,
  resourceId: string,
  activationId?: string
): SidebarShortcutTarget {
  return {
    kind: 'resource',
    locator: { providerId, resourceId },
    ...(activationId === undefined ? {} : { activationId })
  }
}

const LEGACY_PROVIDER_BY_TYPE = {
  app: SIDEBAR_SHORTCUT_PROVIDER_IDS.APP,
  mini_app: SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP,
  agent: SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT,
  assistant: SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT
} as const

type StoredSidebarItem = Record<string, unknown>

function isRecord(value: unknown): value is StoredSidebarItem {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSidebarShortcutTarget(value: unknown): value is SidebarShortcutTarget {
  if (!isRecord(value) || value.kind !== 'resource' || !isRecord(value.locator)) return false
  const { providerId, resourceId } = value.locator
  return (
    typeof providerId === 'string' &&
    providerId.length > 0 &&
    typeof resourceId === 'string' &&
    resourceId.length > 0 &&
    (value.activationId === undefined || (typeof value.activationId === 'string' && value.activationId.length > 0))
  )
}

export function isSidebarShortcutItem(value: unknown): value is SidebarShortcutItem {
  return isRecord(value) && value.type === 'shortcut' && isSidebarShortcutTarget(value.target)
}

function normalizeKnownSidebarShortcut(value: StoredSidebarItem): SidebarShortcutItem | undefined {
  if (value.type === 'shortcut') {
    if (!isSidebarShortcutTarget(value.target)) return undefined
    if (RETIRED_SIDEBAR_SHORTCUT_PROVIDER_IDS.has(value.target.locator.providerId)) return undefined
    return {
      type: 'shortcut',
      id: createSidebarShortcutId(value.target),
      target: value.target,
      ...(typeof value.fallbackLabel === 'string' && value.fallbackLabel.length > 0
        ? { fallbackLabel: value.fallbackLabel }
        : {})
    }
  }

  if (typeof value.type !== 'string' || !Object.hasOwn(LEGACY_PROVIDER_BY_TYPE, value.type)) return undefined
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  if (value.type === 'app' && !isSidebarAppId(value.id)) return undefined

  const providerId = LEGACY_PROVIDER_BY_TYPE[value.type as keyof typeof LEGACY_PROVIDER_BY_TYPE]
  const target = createSidebarShortcutTarget(providerId, value.id)
  return {
    type: 'shortcut',
    id: createSidebarShortcutId(target),
    target,
    ...(typeof value.fallbackLabel === 'string' && value.fallbackLabel.length > 0
      ? { fallbackLabel: value.fallbackLabel }
      : {})
  }
}

function isForwardCompatibleSidebarItem(value: StoredSidebarItem): boolean {
  return (
    typeof value.type === 'string' &&
    value.type !== 'shortcut' &&
    !Object.hasOwn(LEGACY_PROVIDER_BY_TYPE, value.type) &&
    typeof value.id === 'string' &&
    value.id.length > 0
  )
}

export function normalizeSidebarShortcutItems(values: readonly unknown[] | undefined): SidebarShortcutItem[] {
  const items: SidebarShortcutItem[] = []
  const seen = new Set<string>()

  for (const value of values ?? []) {
    if (!isRecord(value)) continue
    const shortcut = normalizeKnownSidebarShortcut(value)
    if (shortcut) {
      if (seen.has(shortcut.id)) continue
      seen.add(shortcut.id)
      items.push(shortcut)
      continue
    }
    if (!isForwardCompatibleSidebarItem(value)) continue

    const futureKey = `${String(value.type)}:${String(value.id)}`
    if (seen.has(futureKey)) continue
    seen.add(futureKey)
    items.push(value as unknown as SidebarShortcutItem)
  }

  return items
}

export function getVisibleSidebarShortcutItems(values: readonly unknown[] | undefined): SidebarShortcutItem[] {
  return normalizeSidebarShortcutItems(values).filter(isSidebarShortcutItem)
}

function isBuiltInAppShortcutTarget(target: SidebarShortcutTarget): target is SidebarShortcutTarget & {
  locator: { providerId: 'core.app'; resourceId: SidebarAppId }
} {
  return (
    target.locator.providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.APP &&
    (target.activationId === undefined || target.activationId === 'reveal') &&
    isSidebarAppId(target.locator.resourceId)
  )
}

export function getVisibleSidebarAppIds(values: readonly unknown[] | undefined): SidebarAppId[] {
  return getVisibleSidebarShortcutItems(values).flatMap((item) =>
    isBuiltInAppShortcutTarget(item.target) ? [item.target.locator.resourceId] : []
  )
}

export function addSidebarShortcut(
  values: readonly unknown[] | undefined,
  target: SidebarShortcutTarget,
  fallbackLabel?: string
): SidebarShortcutItem[] {
  const items = normalizeSidebarShortcutItems(values)
  const id = createSidebarShortcutId(target)
  if (items.some((item) => isSidebarShortcutItem(item) && item.id === id)) return items
  return [
    ...items,
    {
      type: 'shortcut',
      id,
      target,
      ...(fallbackLabel ? { fallbackLabel } : {})
    }
  ]
}

export function removeSidebarShortcut(
  values: readonly unknown[] | undefined,
  target: SidebarShortcutTarget
): SidebarShortcutItem[] {
  const id = createSidebarShortcutId(target)
  return normalizeSidebarShortcutItems(values).filter((item) => !isSidebarShortcutItem(item) || item.id !== id)
}

export function reorderSidebarShortcuts(
  values: readonly unknown[] | undefined,
  orderedItems: readonly SidebarShortcutItem[]
): SidebarShortcutItem[] {
  const items = normalizeSidebarShortcutItems(values)
  const shortcuts = items.filter(isSidebarShortcutItem)
  const byId = new Map(shortcuts.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const reordered: SidebarShortcutItem[] = []

  for (const requested of orderedItems) {
    const item = byId.get(requested.id)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      reordered.push(item)
    }
  }
  for (const item of shortcuts) {
    if (!seen.has(item.id)) reordered.push(item)
  }

  let index = 0
  return items.map((item) => (isSidebarShortcutItem(item) ? reordered[index++] : item))
}

export function isSidebarShortcutPinned(
  values: readonly unknown[] | undefined,
  target: SidebarShortcutTarget
): boolean {
  const id = createSidebarShortcutId(target)
  return getVisibleSidebarShortcutItems(values).some((item) => item.id === id)
}
