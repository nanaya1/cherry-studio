import { isEqual } from 'es-toolkit/compat'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { usePreference } from '@data/hooks/usePreference'
import { sidebarShortcutService } from '@renderer/services/SidebarShortcutService'
import {
  createSidebarShortcutTarget,
  getVisibleSidebarShortcutItems,
  isSidebarAppId,
  isSidebarShortcutPinned,
  normalizeSidebarShortcutItems,
  SIDEBAR_SHORTCUT_PROVIDER_IDS
} from '@renderer/utils/sidebar'
import {
  createSidebarShortcutId,
  type SidebarShortcutItem,
  type SidebarShortcutTarget
} from '@shared/data/preference/preferenceTypes'

import { toast } from '../services/toast'
import { useSidebarFavorites } from './useSidebarFavorites'

export function useSidebarShortcuts() {
  const { t } = useTranslation()
  const [stored] = usePreference('ui.sidebar_shortcut')
  const {
    favorites,
    appFavorites,
    miniAppFavoriteIds,
    agentFavoriteIds,
    assistantFavoriteIds,
    setAppPinned,
    toggleMiniApp,
    removeMiniApp,
    toggleAgent,
    toggleAssistant,
    removeAgent,
    removeAssistant
  } = useSidebarFavorites()
  const resourceShortcuts = useMemo(() => getVisibleSidebarShortcutItems(stored), [stored])
  const favoriteShortcuts = useMemo(
    () =>
      favorites.flatMap<SidebarShortcutItem>((favorite) => {
        const providerId =
          favorite.type === 'app'
            ? SIDEBAR_SHORTCUT_PROVIDER_IDS.APP
            : favorite.type === 'mini_app'
              ? SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP
              : favorite.type === 'agent'
                ? SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT
                : SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT
        const target = createSidebarShortcutTarget(providerId, favorite.id)
        return [{ type: 'shortcut', id: createSidebarShortcutId(target), target }]
      }),
    [favorites]
  )
  const shortcuts = useMemo(
    () => [
      ...favoriteShortcuts,
      ...resourceShortcuts.filter(
        (shortcut) =>
          !favoriteShortcuts.some((favorite) => favorite.id === shortcut.id) &&
          ![
            SIDEBAR_SHORTCUT_PROVIDER_IDS.APP,
            SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP,
            SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT,
            SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT
          ].includes(shortcut.target.locator.providerId as never)
      )
    ],
    [favoriteShortcuts, resourceShortcuts]
  )
  const normalized = useMemo(() => normalizeSidebarShortcutItems(stored), [stored])
  const needsNormalization = !isEqual(stored, normalized)

  const runMutation = useCallback(
    (operation: Promise<void>) => {
      void operation.catch(() => toast.error(t('common.error')))
    },
    [t]
  )

  useEffect(() => {
    if (needsNormalization) runMutation(sidebarShortcutService.normalize())
  }, [needsNormalization, runMutation])

  const isPinned = useCallback(
    (target: SidebarShortcutTarget) => {
      const { providerId, resourceId } = target.locator
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.APP && isSidebarAppId(resourceId)) {
        return appFavorites.includes(resourceId)
      }
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP) return miniAppFavoriteIds.includes(resourceId)
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT) return agentFavoriteIds.includes(resourceId)
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT) return assistantFavoriteIds.includes(resourceId)
      return isSidebarShortcutPinned(resourceShortcuts, target)
    },
    [agentFavoriteIds, appFavorites, assistantFavoriteIds, miniAppFavoriteIds, resourceShortcuts]
  )
  const setPinned = useCallback(
    (target: SidebarShortcutTarget, pinned: boolean, fallbackLabel?: string) => {
      const { providerId, resourceId } = target.locator
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.APP && isSidebarAppId(resourceId)) {
        setAppPinned(resourceId, pinned)
        return
      }
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP) {
        if (miniAppFavoriteIds.includes(resourceId) !== pinned) toggleMiniApp(resourceId)
        return
      }
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT) {
        if (agentFavoriteIds.includes(resourceId) !== pinned) toggleAgent(resourceId)
        return
      }
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT) {
        if (assistantFavoriteIds.includes(resourceId) !== pinned) toggleAssistant(resourceId)
        return
      }
      runMutation(sidebarShortcutService.setPinned(target, pinned, fallbackLabel))
    },
    [
      agentFavoriteIds,
      assistantFavoriteIds,
      miniAppFavoriteIds,
      runMutation,
      setAppPinned,
      toggleAgent,
      toggleAssistant,
      toggleMiniApp
    ]
  )
  const remove = useCallback(
    (target: SidebarShortcutTarget) => {
      const { providerId, resourceId } = target.locator
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.MINI_APP) return removeMiniApp(resourceId)
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.AGENT) return removeAgent(resourceId)
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT) return removeAssistant(resourceId)
      if (providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.APP && isSidebarAppId(resourceId)) {
        return setAppPinned(resourceId, false)
      }
      runMutation(sidebarShortcutService.remove(target))
    },
    [removeAgent, removeAssistant, removeMiniApp, runMutation, setAppPinned]
  )
  const reorder = useCallback(
    (items: readonly SidebarShortcutItem[]) => {
      const operation = sidebarShortcutService.reorder(items)
      runMutation(operation)
      return operation
    },
    [runMutation]
  )

  return { shortcuts, isPinned, setPinned, remove, reorder }
}
