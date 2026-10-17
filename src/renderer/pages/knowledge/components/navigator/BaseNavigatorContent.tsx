import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Accordion, EmptyState, Scrollbar } from '@cherrystudio/ui'
import { useSidebarShortcuts } from '@renderer/hooks/useSidebarShortcuts'
import { createSidebarShortcutTarget, SIDEBAR_SHORTCUT_PROVIDER_IDS } from '@renderer/utils/sidebar'
import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'

import BaseNavigatorGroupSection from './BaseNavigatorGroupSection'
import KnowledgeBaseRow from './KnowledgeBaseRow'
import type { BaseNavigatorContentProps } from './types'
import { UNGROUPED_SECTION_VALUE } from './types'

const BaseNavigatorContent = ({
  isLoading,
  remoteRows,
  sections,
  groups,
  groupById,
  sharedBaseIds,
  onRequestUnshare,
  selectedBaseId,
  getGroupLabel,
  onSelectBase,
  onMoveBase,
  onRenameBase,
  onRenameGroup,
  onCreateBaseInGroup,
  onCreateGroup,
  onDeleteGroup,
  onDeleteBase
}: BaseNavigatorContentProps) => {
  const { t } = useTranslation()
  const {
    shortcuts: sidebarShortcuts,
    setPinned: setSidebarShortcutPinned,
    remove: removeSidebarShortcut
  } = useSidebarShortcuts()
  const sidebarPinnedBaseIds = useMemo(
    () =>
      new Set(
        sidebarShortcuts.flatMap((shortcut) =>
          shortcut.target.locator.providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.KNOWLEDGE_BASE
            ? [shortcut.target.locator.resourceId]
            : []
        )
      ),
    [sidebarShortcuts]
  )
  const handleToggleSidebar = useCallback(
    (base: KnowledgeBaseListItem) => {
      const target = createSidebarShortcutTarget(SIDEBAR_SHORTCUT_PROVIDER_IDS.KNOWLEDGE_BASE, base.id)
      if (sidebarPinnedBaseIds.has(base.id)) removeSidebarShortcut(target)
      else setSidebarShortcutPinned(target, true, base.name)
    },
    [removeSidebarShortcut, sidebarPinnedBaseIds, setSidebarShortcutPinned]
  )

  const sectionValues = useMemo(() => sections.map(({ groupId }) => groupId ?? UNGROUPED_SECTION_VALUE), [sections])
  // Controlled rather than defaultValue (which is mount-time only) so a group
  // created while the accordion is mounted starts expanded — otherwise a base
  // moved into a freshly created group would look like it vanished. Tracking
  // what the user collapsed (instead of what is open) keeps newly appearing
  // sections open by default.
  const [collapsedValues, setCollapsedValues] = useState<readonly string[]>([])
  const openValues = useMemo(
    () => sectionValues.filter((value) => !collapsedValues.includes(value)),
    [collapsedValues, sectionValues]
  )
  const handleValueChange = useCallback(
    (nextOpenValues: string[]) => {
      setCollapsedValues(sectionValues.filter((value) => !nextOpenValues.includes(value)))
    },
    [sectionValues]
  )

  // Without any group there is nothing to head the list with — render the bases
  // flat instead of under a lone "default" section header. A base whose groupId
  // points at a deleted group still yields its own section, so that (unexpected)
  // shape keeps the accordion.
  const flatSection = groups.length === 0 && sections.length === 1 && sections[0].groupId === null ? sections[0] : null

  // `pt-1 pb-3` mirrors the assistant and agent rails' list padding — the top inset is
  // what separates the first row from the create action above it.
  return (
    <Scrollbar className="min-h-0 flex-1 overflow-x-hidden pt-1 pb-3">
      <div data-knowledge-local-remote-rows={remoteRows?.length ? true : undefined} className="space-y-1">
        {groups.length === 0
          ? remoteRows?.map((row) => (
              <KnowledgeBaseRow
                key={row.id}
                base={{ id: row.id, name: row.name, groupId: null }}
                remote
                shared
                groups={groups}
                selected={row.selected}
                onSelectBase={row.onSelect}
                onMoveBase={(_id, groupId) => row.onMove?.(groupId)}
                onRenameBase={() => row.onRename?.()}
                onCreateGroup={() => row.onCreateGroup?.()}
                onRequestUnshare={() => row.onUnshare?.()}
                onDeleteBase={() => row.onDelete?.()}
                onToggleSidebar={() => {}}
                sidebarPinned={false}
              />
            ))
          : null}
      </div>
      {isLoading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : (sections.length === 0 || (flatSection && flatSection.items.length === 0)) && !remoteRows?.length ? (
        // KnowledgePage normally owns the zero-base empty state; keep a defensive fallback
        // for a transient empty collection while navigator data changes.
        <EmptyState preset="no-result" title={t('common.no_results')} compact className="h-full" />
      ) : flatSection ? (
        <div className="space-y-1">
          {flatSection.items.map((base) => (
            <KnowledgeBaseRow
              key={base.id}
              base={base}
              groups={groups}
              shared={sharedBaseIds?.has(base.id)}
              onRequestUnshare={onRequestUnshare}
              selected={base.id === selectedBaseId}
              onSelectBase={onSelectBase}
              onMoveBase={onMoveBase}
              onRenameBase={onRenameBase}
              onCreateGroup={onCreateGroup}
              onDeleteBase={onDeleteBase}
              onToggleSidebar={handleToggleSidebar}
              sidebarPinned={sidebarPinnedBaseIds.has(base.id)}
            />
          ))}
        </div>
      ) : (
        <Accordion type="multiple" value={openValues} onValueChange={handleValueChange} className="space-y-3">
          {sections.map((section) => {
            const groupValue = section.groupId ?? UNGROUPED_SECTION_VALUE
            const group = section.groupId ? groupById.get(section.groupId) : undefined

            return (
              <BaseNavigatorGroupSection
                key={groupValue}
                section={section}
                remoteRows={remoteRows?.filter((row) => (row.groupId ?? null) === section.groupId)}
                group={group}
                groupLabel={group?.name ?? getGroupLabel(section.groupId)}
                groups={groups}
                sharedBaseIds={sharedBaseIds}
                onRequestUnshare={onRequestUnshare}
                selectedBaseId={selectedBaseId}
                onSelectBase={onSelectBase}
                onMoveBase={onMoveBase}
                onRenameBase={onRenameBase}
                onRenameGroup={onRenameGroup}
                onCreateBaseInGroup={onCreateBaseInGroup}
                onCreateGroup={onCreateGroup}
                onDeleteGroup={onDeleteGroup}
                onDeleteBase={onDeleteBase}
                onToggleSidebar={handleToggleSidebar}
                sidebarPinnedBaseIds={sidebarPinnedBaseIds}
              />
            )
          })}
        </Accordion>
      )}
    </Scrollbar>
  )
}

export default BaseNavigatorContent
