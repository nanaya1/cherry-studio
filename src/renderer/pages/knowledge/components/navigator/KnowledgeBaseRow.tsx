// import { ArrowRightLeft, FolderPlus, PencilLine, Trash2 } from 'lucide-react'
import { ArrowRightLeft, FolderPlus, PencilLine, Share2, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, ConfirmDialog } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import SidebarShortcutIcon from '@renderer/components/icons/SidebarShortcutIcon'
import KnowledgeRowActionsMenu from '@renderer/pages/knowledge/components/KnowledgeRowActionsMenu'
import { DEFAULT_KNOWLEDGE_GROUP_LABEL_KEY } from '@renderer/pages/knowledge/utils/group'

import KnowledgeUploadDetails, { useKnowledgeUpload } from '../KnowledgeUploadDetails'
import type { KnowledgeBaseRowProps } from './types'

const KnowledgeBaseRow = ({
  base,
  groups,
  shared,
  onRequestUnshare,
  selected,
  onSelectBase,
  onMoveBase,
  onRenameBase,
  onCreateGroup,
  onDeleteBase,
  onToggleSidebar,
  sidebarPinned
}: KnowledgeBaseRowProps) => {
  const { t } = useTranslation()
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const upload = useKnowledgeUpload(base.id)
  const uploading = upload && upload.phase !== 'completed'
  const availableGroups = useMemo(() => groups.filter((group) => group.id !== base.groupId), [base.groupId, groups])
  const canMoveToUngrouped = base.groupId !== null

  const handleMoveBase = useCallback(
    async (groupId: string | null) => {
      if (base.groupId === groupId) return
      await onMoveBase(base.id, groupId)
    },
    [base.groupId, base.id, onMoveBase]
  )

  const handleRenameBase = useCallback(() => {
    onRenameBase({ id: base.id, name: base.name })
  }, [base.id, base.name, onRenameBase])

  const handleCreateGroup = useCallback(() => {
    onCreateGroup(base.id)
  }, [base.id, onCreateGroup])

  const handleRequestDelete = useCallback(() => {
    setIsDeleteDialogOpen(true)
  }, [])

  const handleDeleteBase = useCallback(async () => {
    await onDeleteBase(base.id)
  }, [base.id, onDeleteBase])

  const contextMenuItems = useMemo<CommandContextMenuExtraItem[]>(() => {
    const items: CommandContextMenuExtraItem[] = [
      {
        type: 'item',
        id: 'rename',
        label: t('knowledge.context.rename'),
        icon: <PencilLine className="size-3.5" />,
        onSelect: handleRenameBase
      }
    ]

    if (canMoveToUngrouped || availableGroups.length > 0) {
      items.push({
        type: 'submenu',
        id: 'move',
        label: t('knowledge.context.move_to'),
        icon: <ArrowRightLeft className="size-3.5" />,
        children: [
          ...(canMoveToUngrouped
            ? ([
                {
                  type: 'item' as const,
                  id: 'move-to-ungrouped',
                  label: t(DEFAULT_KNOWLEDGE_GROUP_LABEL_KEY),
                  onSelect: () => void handleMoveBase(null)
                }
              ] as const)
            : []),
          ...availableGroups.map((group) => ({
            type: 'item' as const,
            id: `move-to-${group.id}`,
            label: group.name,
            onSelect: () => void handleMoveBase(group.id)
          })),
          { type: 'separator' as const },
          // Creating a group from here also moves this base into it (see
          // KnowledgePageProvider.submitCreateGroup), same as the top-level entry below.
          {
            type: 'item' as const,
            id: 'create-group',
            label: t('knowledge.groups.add'),
            onSelect: handleCreateGroup
          }
        ]
      })
    } else {
      // No group exists and the base is ungrouped — no move targets to offer, so
      // surface group creation directly (the sole entry point for the first group).
      items.push({
        type: 'item',
        id: 'create-group',
        label: t('knowledge.groups.add'),
        icon: <FolderPlus className="size-3.5" />,
        onSelect: handleCreateGroup
      })
    }

    items.push({
      type: 'item',
      id: 'toggle-sidebar',
      label: t(sidebarPinned ? 'launchpad.unpin_from_sidebar' : 'launchpad.pin_to_sidebar'),
      icon: <SidebarShortcutIcon pinned={sidebarPinned} className="size-3.5" />,
      onSelect: () => onToggleSidebar(base)
    })
    // MEA:enterprise-knowledge-page 列表与右键菜单复用取消分享确认入口。
    if (shared && onRequestUnshare) {
      items.push({
        type: 'item',
        id: 'unshare',
        label: t('knowledge.org.unshare'),
        icon: <Share2 className="size-3.5" />,
        // destructive: true,
        onSelect: () => onRequestUnshare(base.id)
      })
    }
    items.push({ type: 'separator' })
    items.push({
      type: 'item',
      id: 'delete',
      label: t('knowledge.context.delete'),
      icon: <Trash2 className="size-3.5" />,
      destructive: true,
      onSelect: handleRequestDelete
    })

    return items
  }, [
    availableGroups,
    base,
    canMoveToUngrouped,
    handleCreateGroup,
    handleMoveBase,
    handleRenameBase,
    handleRequestDelete,
    onToggleSidebar,
    sidebarPinned,
    shared,
    onRequestUnshare,
    t
  ])

  return (
    <>
      <CommandContextMenu location="webcontents.context" extraItems={contextMenuItems}>
        <div
          className={cn(
            'group/row flex h-8 w-full items-center gap-1 rounded-md px-2.5 transition-colors',
            selected ? 'bg-muted text-foreground' : 'hover:bg-muted'
          )}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSelectBase(base.id)}
            className="flex min-h-0 min-w-0 flex-1 items-center justify-start rounded-md p-0 text-left shadow-none hover:bg-transparent">
            <div className="min-w-0 truncate text-sm leading-5 font-normal text-foreground">{base.name}</div>
          </Button>
          {uploading ? (
            <Button variant="ghost" className="h-5 shrink-0 px-1 text-[10px]" onClick={() => setUploadOpen(true)}>
              {t(upload.phase === 'paused' ? 'knowledge.org.upload_paused' : 'knowledge.org.upload_sharing')}{' '}
              {upload.totalBytes ? Math.floor((upload.uploadedBytes / upload.totalBytes) * 100) : 0}%
            </Button>
          ) : null}
          {shared && !uploading ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1 py-0 text-[10px] leading-none border-emerald-600/25 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
              {t('knowledge.org.shared_tag')}
            </Badge>
          ) : null}
          <KnowledgeRowActionsMenu items={contextMenuItems} />
        </div>
      </CommandContextMenu>

      {uploadOpen ? (
        <KnowledgeUploadDetails baseId={base.id} name={base.name} onClose={() => setUploadOpen(false)} />
      ) : null}
      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title={t('knowledge.context.delete_confirm_title')}
        description={t('knowledge.context.delete_confirm_description')}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        destructive
        onConfirm={handleDeleteBase}
      />
    </>
  )
}

export default KnowledgeBaseRow
