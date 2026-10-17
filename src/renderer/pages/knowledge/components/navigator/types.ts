import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { KnowledgePageBaseGroupSection } from '@renderer/pages/knowledge/utils/group'
import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import type { Group } from '@shared/data/types/group'
import type { KnowledgeBase } from '@shared/data/types/knowledge'

export interface BaseNavigatorRemoteRow {
  id: string
  name: string
  selected: boolean
  onSelect: () => void
  tag: string
  groupId?: string | null
  onMove?: (groupId: string | null) => void
  onRename?: () => void
  onCreateGroup?: () => void
  onUnshare?: () => void
  onDelete?: () => void
}

export interface BaseNavigatorContentProps {
  isLoading: boolean
  remoteRows?: BaseNavigatorRemoteRow[]

  sections: KnowledgePageBaseGroupSection[]
  groups: Group[]
  groupById: ReadonlyMap<string, Group>
  sharedBaseIds?: ReadonlySet<string>
  onRequestUnshare?: (baseId: string) => void
  selectedBaseId: string
  getGroupLabel: (groupId: string | null) => string
  onSelectBase: (baseId: string) => void
  onMoveBase: (baseId: string, groupId: string | null) => Promise<void> | void
  onRenameBase: (base: Pick<KnowledgeBase, 'id' | 'name'> & { remote?: boolean }) => void
  onRenameGroup: (group: Pick<Group, 'id' | 'name'>) => void
  onCreateBaseInGroup: (groupId: string) => void
  onCreateGroup: (baseId: string) => void
  onDeleteGroup: (groupId: string) => Promise<void> | void
  onDeleteBase: (baseId: string) => Promise<void> | void
}

export interface BaseNavigatorGroupSectionProps {
  section: KnowledgePageBaseGroupSection
  group?: Group
  groupLabel: string
  groups: Group[]
  sharedBaseIds?: ReadonlySet<string>
  onRequestUnshare?: (baseId: string) => void
  selectedBaseId: string
  onSelectBase: (baseId: string) => void
  onMoveBase: (baseId: string, groupId: string | null) => Promise<void> | void
  onRenameBase: (base: Pick<KnowledgeBase, 'id' | 'name'> & { remote?: boolean }) => void
  onRenameGroup: (group: Pick<Group, 'id' | 'name'>) => void
  onCreateBaseInGroup: (groupId: string) => void
  onCreateGroup: (baseId: string) => void
  onDeleteGroup: (groupId: string) => Promise<void> | void
  onDeleteBase: (baseId: string) => Promise<void> | void
  onToggleSidebar: (base: KnowledgeBaseListItem) => void
  sidebarPinnedBaseIds: ReadonlySet<string>
  remoteRows?: BaseNavigatorRemoteRow[]
}

export interface BaseNavigatorSectionTriggerProps {
  label: string
  leadingSlot?: ReactNode
  actionSlot?: ReactNode
}

export interface BaseNavigatorResizeHandleProps {
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
}

export interface KnowledgeBaseRowProps {
  base: Pick<KnowledgeBaseListItem, 'id' | 'name' | 'groupId'>
  remote?: boolean
  groups: Group[]
  shared?: boolean
  onRequestUnshare?: (baseId: string) => void
  selected: boolean
  onSelectBase: (baseId: string) => void
  onMoveBase: (baseId: string, groupId: string | null) => Promise<void> | void
  onRenameBase: (base: Pick<KnowledgeBase, 'id' | 'name'> & { remote?: boolean }) => void
  onCreateGroup: (baseId: string) => void
  onDeleteBase: (baseId: string) => Promise<void> | void
  onToggleSidebar: (base: KnowledgeBaseListItem) => void
  sidebarPinned: boolean
}

export interface KnowledgeGroupRowProps {
  group: Group
  onRenameGroup: (group: Pick<Group, 'id' | 'name'>) => void
  onCreateBase: (groupId: string) => void
  onDeleteGroup: (groupId: string) => Promise<void> | void
}

export const UNGROUPED_SECTION_VALUE = 'ungrouped'
