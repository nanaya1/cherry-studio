import {
  createContext,
  type PropsWithChildren,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  useCreateKnowledgeBase,
  useDeleteKnowledgeBase,
  useKnowledgeBases,
  useRestoreKnowledgeBase,
  useUpdateKnowledgeBase
} from '@renderer/hooks/useKnowledgeBase'
import { useOrgKnowledge } from '@renderer/hooks/useOrgKnowledge'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import type { OrgKnowledgeBase } from '@shared/data/types/enterpriseKnowledge'
import type { Group } from '@shared/data/types/group'
import type { KnowledgeBase, KnowledgeItemType } from '@shared/data/types/knowledge'

import {
  useCreateKnowledgeGroup,
  useDeleteKnowledgeGroup,
  useKnowledgeGroups,
  useUpdateKnowledgeGroup
} from './hooks/useKnowledgeGroups'
import type { KnowledgeRestoreBaseInitialValues } from './panels/ragConfig/RagConfigPanel'
import type { KnowledgeFilePreviewTarget, KnowledgeTabKey } from './types'

type EditableKnowledgeGroup = Pick<Group, 'id' | 'name'>
type EditableKnowledgeBase = Pick<KnowledgeBase, 'id' | 'name'> & { remote?: boolean }
type CreateKnowledgeBase = ReturnType<typeof useCreateKnowledgeBase>['createBase']
type RestoreKnowledgeBase = ReturnType<typeof useRestoreKnowledgeBase>['restoreBase']

interface KnowledgePageContextValue {
  org: ReturnType<typeof useOrgKnowledge>
  category: 'local' | 'public' | 'shared'
  setCategory: (category: 'local' | 'public' | 'shared') => void
  selectedOrgBase: OrgKnowledgeBase | undefined
  selectOrgBase: (base: OrgKnowledgeBase) => void
  orgSession: number
  handleOrgUnshared: () => void
  bases: KnowledgeBaseListItem[]
  groups: Group[]
  isLoading: boolean
  selectedBase: KnowledgeBase | undefined
  selectedBaseId: string
  selectedItemId: string | null
  /** Which detail view the selected item opens into: its original content or its indexed chunks. */
  selectedItemView: 'content' | 'chunks'
  filePreview: KnowledgeFilePreviewTarget | null
  baseNavigationVersion: number
  activeTab: KnowledgeTabKey
  contentRef: RefObject<HTMLDivElement | null>
  editingBase: EditableKnowledgeBase | null
  editingGroup: EditableKnowledgeGroup | null
  restoringBase: KnowledgeBase | null
  restoreBaseInitialValues: KnowledgeRestoreBaseInitialValues | undefined
  isAddSourceDialogOpen: boolean
  pendingAddSource: KnowledgeItemType | undefined
  pendingAddFiles: File[] | undefined
  isRagConfigDrawerOpen: boolean
  isRecallTestDrawerOpen: boolean
  isCreateBaseDialogOpen: boolean
  isCreateGroupDialogOpen: boolean
  createBaseInitialGroupId: string | undefined
  isCreatingBase: boolean
  isCreatingGroup: boolean
  isUpdatingBase: boolean
  isUpdatingGroup: boolean
  isRestoringBase: boolean
  createBase: CreateKnowledgeBase
  restoreBase: RestoreKnowledgeBase
  selectBase: (baseId: string) => void
  setActiveTab: (tab: KnowledgeTabKey) => void
  openItemChunks: (itemId: string) => void
  openItemContent: (itemId: string) => void
  closeItemChunks: () => void
  openFilePreview: (target: KnowledgeFilePreviewTarget) => void
  closeFilePreview: () => void
  openAddSourceDialog: (source?: KnowledgeItemType, files?: File[]) => void
  openRagConfigDrawer: () => void
  openRecallTestDrawer: () => void
  handleRagConfigDrawerOpenChange: (open: boolean) => void
  handleRecallTestDrawerOpenChange: (open: boolean) => void
  openCreateBaseDialog: (groupId?: string) => void
  openCreateGroupDialog: (baseIdToMove?: string) => void
  openRenameBaseDialog: (base: EditableKnowledgeBase) => void
  openRenameGroupDialog: (group: EditableKnowledgeGroup) => void
  openRestoreBaseDialog: (base: KnowledgeBase, initialValues?: KnowledgeRestoreBaseInitialValues) => void
  handleAddSourceDialogOpenChange: (open: boolean) => void
  handleCreateBaseDialogOpenChange: (open: boolean) => void
  handleCreateGroupDialogOpenChange: (open: boolean) => void
  handleRenameBaseDialogOpenChange: (open: boolean) => void
  handleRenameGroupDialogOpenChange: (open: boolean) => void
  handleRestoreBaseDialogOpenChange: (open: boolean) => void
  handleCreateBaseCreated: (createdBase: { id: string }) => void
  handleRestoreBaseRestored: (restoredBase: { id: string }) => void
  submitCreateGroup: (name: string) => Promise<void>
  submitRenameBase: (name: string) => Promise<void>
  submitRenameGroup: (name: string) => Promise<void>
  moveBase: (baseId: string, groupId: string | null) => Promise<void>
  deleteBase: (baseId: string) => Promise<void>
  deleteGroup: (groupId: string) => Promise<void>
}

const KnowledgePageContext = createContext<KnowledgePageContextValue | null>(null)

interface KnowledgePageProviderProps extends PropsWithChildren {
  baseId?: string
  onBaseIdChange: (baseId?: string) => void
}

export const KnowledgePageProvider = ({ children, baseId, onBaseIdChange }: KnowledgePageProviderProps) => {
  const { t } = useTranslation()
  const { bases, isLoading, error: basesError, refetch: refetchBases } = useKnowledgeBases()
  const { groups } = useKnowledgeGroups()
  const org = useOrgKnowledge()
  const [category, updateCategory] = useState<'local' | 'public' | 'shared'>('local')
  const setCategory = useCallback((value: 'local' | 'public' | 'shared') => {
    updateCategory(value)
    setOrgBaseId(null)
  }, [])
  const [orgBaseId, setOrgBaseId] = useState<string | null>(null)
  const [orgSession, setOrgSession] = useState(0)
  // 与 orgSession 同步的可变镜像：事件自增可穿透 async 闭包，供 submitRenameBase 比对。
  const orgSessionRef = useRef(orgSession)
  useIpcOn('enterprise.status_changed', () => {
    setOrgBaseId(null)
    setOrgSession((value) => value + 1)
    orgSessionRef.current += 1
  })
  const [selectionRoute, setSelectionRoute] = useState(baseId)
  if (selectionRoute !== baseId) {
    setSelectionRoute(baseId)
    setOrgBaseId(null)
  }
  // MEA:enterprise-knowledge-page owned 副本属于本地管理区，不能混入分享给我的目录。
  // const selectedOrgBase = (category === 'local' ? org.catalog.owned : org.catalog[category]).find(
  //   (base) => base.id === orgBaseId
  // )
  const currentOrgBaseId = selectionRoute === baseId ? orgBaseId : null
  const selectedOrgBase = (category === 'local' ? org.catalog.owned : org.catalog[category]).find((base) =>
    currentOrgBaseId
      ? base.id === currentOrgBaseId
      : category === 'local' && Boolean(baseId) && base.localBaseId === baseId
  )
  const selectOrgBase = useCallback((base: OrgKnowledgeBase) => setOrgBaseId(base.id), [])
  const { createGroup, isCreating: isCreatingGroup } = useCreateKnowledgeGroup()
  const { createBase, isCreating: isCreatingBase } = useCreateKnowledgeBase()
  const { restoreBase, isRestoring: isRestoringBase } = useRestoreKnowledgeBase()
  // 原 useUpdateKnowledgeBase.isUpdating 字段保留并别名，避免 isRenamingBase 影响其它 update 操作。
  const { updateBase, isUpdating: isUpdatingLocalBase } = useUpdateKnowledgeBase()
  const { updateGroup, isUpdating: isUpdatingGroup } = useUpdateKnowledgeGroup()
  const { deleteBase } = useDeleteKnowledgeBase()
  const { deleteGroup } = useDeleteKnowledgeGroup()
  const selectedBaseId = baseId ?? ''
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [selectedItemView, setSelectedItemView] = useState<'content' | 'chunks'>('content')
  const [filePreview, setFilePreview] = useState<KnowledgeFilePreviewTarget | null>(null)
  const [previewNavigationVersion, setPreviewNavigationVersion] = useState(0)
  const [baseNavigationVersion, setBaseNavigationVersion] = useState(0)
  const previewNavigationVersionRef = useRef(0)
  const [pendingSelectedBaseId, setPendingSelectedBaseId] = useState<string | null>(null)
  const pendingSelectedBaseListRef = useRef<KnowledgeBase[] | null>(null)
  const [activeTab, setActiveTab] = useState<KnowledgeTabKey>('data')
  const [editingBase, setEditingBase] = useState<EditableKnowledgeBase | null>(null)
  // 重命名提交态：覆盖本地 + 云端全过程，云端期间禁止重复提交（同名弹窗仍打开）。
  const [isRenamingBase, setIsRenamingBase] = useState(false)
  const [editingGroup, setEditingGroup] = useState<EditableKnowledgeGroup | null>(null)
  const [restoringBase, setRestoringBase] = useState<KnowledgeBase | null>(null)
  const [restoreBaseInitialValues, setRestoreBaseInitialValues] = useState<
    KnowledgeRestoreBaseInitialValues | undefined
  >()
  const [isAddSourceDialogOpen, setIsAddSourceDialogOpen] = useState(false)
  const [pendingAddSource, setPendingAddSource] = useState<KnowledgeItemType | undefined>()
  const [pendingAddFiles, setPendingAddFiles] = useState<File[] | undefined>()
  const [isRagConfigDrawerOpen, setIsRagConfigDrawerOpen] = useState(false)
  const [isRecallTestDrawerOpen, setIsRecallTestDrawerOpen] = useState(false)
  const [isCreateBaseDialogOpen, setIsCreateBaseDialogOpen] = useState(false)
  const [createBaseInitialGroupId, setCreateBaseInitialGroupId] = useState<string | undefined>()
  const [isCreateGroupDialogOpen, setIsCreateGroupDialogOpen] = useState(false)
  // Set when the create-group dialog is opened from a base's context menu: the
  // freshly created group immediately adopts that base (create-and-move in one go).
  const [pendingGroupMoveBaseId, setPendingGroupMoveBaseId] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const selectedBase = useMemo(() => {
    return bases.find((base) => base.id === selectedBaseId)
  }, [bases, selectedBaseId])

  const resetFilePreview = useCallback(() => {
    const nextVersion = previewNavigationVersionRef.current + 1
    previewNavigationVersionRef.current = nextVersion
    setPreviewNavigationVersion(nextVersion)
    setFilePreview(null)
  }, [])

  const resetBaseNavigation = useCallback(() => {
    resetFilePreview()
    setBaseNavigationVersion((version) => version + 1)
    setSelectedItemId(null)
    setActiveTab('data')
    setIsAddSourceDialogOpen(false)
    setPendingAddSource(undefined)
    setPendingAddFiles(undefined)
    setIsRagConfigDrawerOpen(false)
    setIsRecallTestDrawerOpen(false)
  }, [resetFilePreview])

  const openFilePreview = useCallback(
    (target: KnowledgeFilePreviewTarget) => {
      if (previewNavigationVersionRef.current !== previewNavigationVersion) return
      setFilePreview(target)
    },
    [previewNavigationVersion]
  )

  useEffect(() => {
    if (isLoading || basesError) return

    if (pendingSelectedBaseId) {
      if (bases.some((base) => base.id === pendingSelectedBaseId)) {
        setPendingSelectedBaseId(null)
        pendingSelectedBaseListRef.current = null
        return
      }

      if (bases.length === 0 || bases === pendingSelectedBaseListRef.current) {
        return
      }

      setPendingSelectedBaseId(null)
      pendingSelectedBaseListRef.current = null
    }

    if (bases.length === 0) {
      if (selectedBaseId) {
        resetBaseNavigation()
        onBaseIdChange()
      }
      setSelectedItemId(null)
      return
    }

    const hasSelectedBase = bases.some((base) => base.id === selectedBaseId)
    if (!selectedBaseId || !hasSelectedBase) {
      resetBaseNavigation()
      setSelectedItemId(null)
      onBaseIdChange(bases[0].id)
    }
  }, [bases, basesError, isLoading, onBaseIdChange, pendingSelectedBaseId, resetBaseNavigation, selectedBaseId])

  const handleOrgUnshared = useCallback(() => {
    if (previewNavigationVersion !== previewNavigationVersionRef.current || orgSession !== orgSessionRef.current) return
    const navigation = previewNavigationVersionRef.current
    const session = orgSessionRef.current
    void Promise.allSettled([org.refresh(), refetchBases()]).then(() => {
      if (navigation !== previewNavigationVersionRef.current || session !== orgSessionRef.current) return
      setCategory('local')
      setPendingSelectedBaseId(null)
      pendingSelectedBaseListRef.current = null
      setSelectedItemId(null)
      resetBaseNavigation()
      onBaseIdChange()
    })
    // }, [org, refetchBases, setCategory, resetBaseNavigation, onBaseIdChange])
  }, [org, refetchBases, setCategory, resetBaseNavigation, onBaseIdChange, previewNavigationVersion, orgSession])

  const selectBase = useCallback(
    (baseId: string) => {
      setCategory('local')
      // MEA:enterprise-knowledge-page 同机关联入口使用云端权威详情。
      const owned = org.catalog.owned.find((base) => base.localBaseId === baseId)
      if (owned) setOrgBaseId(owned.id)
      resetBaseNavigation()

      if (bases.some((base) => base.id === baseId)) {
        setPendingSelectedBaseId(null)
        pendingSelectedBaseListRef.current = null
      } else {
        setPendingSelectedBaseId(baseId)
        pendingSelectedBaseListRef.current = bases
      }

      onBaseIdChange(baseId)
      setSelectedItemId(null)
    },
    // [bases, resetBaseNavigation, onBaseIdChange, setCategory]
    [bases, org.catalog.owned, resetBaseNavigation, onBaseIdChange, setCategory]
  )

  // useEffect(() => {
  // MEA:enterprise-knowledge-page 提交切库后、绘制前清除本机预览与弹窗。
  useLayoutEffect(() => {
    resetBaseNavigation()
    setSelectedItemId(null)
    // }, [selectedBaseId, resetBaseNavigation])
  }, [selectedBaseId, selectedOrgBase?.id, category, orgSession, resetBaseNavigation])

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.GLOBAL_SEARCH_SELECT_KNOWLEDGE_BASE, (baseId) => {
      if (typeof baseId !== 'string') return
      selectBase(baseId)
    })

    return () => {
      unsubscribe()
    }
  }, [selectBase])

  const handleSetActiveTab = useCallback((tab: KnowledgeTabKey) => {
    setActiveTab(tab)
    setSelectedItemId(null)
  }, [])

  const openItemChunks = useCallback((itemId: string) => {
    setSelectedItemView('chunks')
    setSelectedItemId(itemId)
  }, [])

  const openItemContent = useCallback((itemId: string) => {
    setSelectedItemView('content')
    setSelectedItemId(itemId)
  }, [])

  const closeItemChunks = useCallback(() => {
    setSelectedItemId(null)
  }, [])

  const openCreateBaseDialog = useCallback((groupId?: string) => {
    setCreateBaseInitialGroupId(groupId)
    setIsCreateBaseDialogOpen(true)
  }, [])

  const openAddSourceDialog = useCallback((source?: KnowledgeItemType, files?: File[]) => {
    setPendingAddSource(source)
    setPendingAddFiles(files?.length ? files : undefined)
    setIsAddSourceDialogOpen(true)
  }, [])

  const openRagConfigDrawer = useCallback(() => {
    setIsRagConfigDrawerOpen(true)
  }, [])

  const openRecallTestDrawer = useCallback(() => {
    setIsRecallTestDrawerOpen(true)
  }, [])

  const handleRagConfigDrawerOpenChange = useCallback((open: boolean) => {
    setIsRagConfigDrawerOpen(open)
  }, [])

  const handleRecallTestDrawerOpenChange = useCallback((open: boolean) => {
    setIsRecallTestDrawerOpen(open)
  }, [])

  const openCreateGroupDialog = useCallback((baseIdToMove?: string) => {
    setPendingGroupMoveBaseId(baseIdToMove ?? null)
    setIsCreateGroupDialogOpen(true)
  }, [])

  const openRenameBaseDialog = useCallback((base: EditableKnowledgeBase) => {
    setEditingBase(base)
  }, [])

  const openRenameGroupDialog = useCallback((group: EditableKnowledgeGroup) => {
    setEditingGroup(group)
  }, [])

  const openRestoreBaseDialog = useCallback(
    (base: KnowledgeBase, initialValues?: KnowledgeRestoreBaseInitialValues) => {
      setRestoringBase(base)
      setRestoreBaseInitialValues(initialValues)
    },
    []
  )

  const handleCreateBaseDialogOpenChange = useCallback((open: boolean) => {
    setIsCreateBaseDialogOpen(open)

    if (!open) {
      setCreateBaseInitialGroupId(undefined)
    }
  }, [])

  const handleAddSourceDialogOpenChange = useCallback((open: boolean) => {
    setIsAddSourceDialogOpen(open)
    if (!open) {
      setPendingAddSource(undefined)
      setPendingAddFiles(undefined)
    }
  }, [])

  const handleCreateGroupDialogOpenChange = useCallback((open: boolean) => {
    setIsCreateGroupDialogOpen(open)

    if (!open) {
      setPendingGroupMoveBaseId(null)
    }
  }, [])

  const handleRenameBaseDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setEditingBase(null)
    }
  }, [])

  const handleRenameGroupDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setEditingGroup(null)
    }
  }, [])

  const handleRestoreBaseDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRestoringBase(null)
      setRestoreBaseInitialValues(undefined)
    }
  }, [])

  const handleCreateBaseCreated = useCallback(
    (createdBase: { id: string }) => {
      selectBase(createdBase.id)
    },
    [selectBase]
  )

  const handleRestoreBaseRestored = useCallback(
    (restoredBase: { id: string }) => {
      setRestoringBase(null)
      setRestoreBaseInitialValues(undefined)
      selectBase(restoredBase.id)
    },
    [selectBase]
  )

  const moveBase = useCallback(
    async (baseId: string, groupId: string | null) => {
      try {
        if (baseId.startsWith('orgkb:')) {
          await ipcApi.request('enterprise.knowledge.move_local_group', { baseId, groupId })
          await org.refresh()
        } else {
          await updateBase(baseId, { groupId })
        }
      } catch (error) {
        toast.error(formatErrorMessageWithPrefix(error, t('knowledge.error.failed_to_move')))
      }
    },
    [t, updateBase, org]
  )

  const submitCreateGroup = useCallback(
    async (name: string) => {
      const group = await createGroup(name)
      const baseIdToMove = pendingGroupMoveBaseId
      setIsCreateGroupDialogOpen(false)
      setPendingGroupMoveBaseId(null)

      // Opened from a base's context menu: the new group adopts that base right
      // away. moveBase surfaces its own failure toast and never rejects, so a
      // failed move can't resurrect the already-closed dialog.
      if (baseIdToMove) {
        await moveBase(baseIdToMove, group.id)
      }
    },
    [createGroup, moveBase, pendingGroupMoveBaseId]
  )

  const submitRenameBase = useCallback(
    async (name: string) => {
      if (!editingBase) {
        return
      }

      if (isRenamingBase) {
        return
      }

      const originalName = editingBase.name.trim()
      const normalized = name.trim()

      if (normalized === originalName) {
        setEditingBase(null)
        return
      }

      const targetLocalBaseId = editingBase.id
      // 用 ref 穿透闭包：事件自增后，await 仍可比对出账号是否切换。
      const capturedSession = orgSessionRef.current

      setIsRenamingBase(true)
      try {
        const ownedBinding = org.catalog.owned.find(
          (base) => base.localBaseId === targetLocalBaseId || base.id === targetLocalBaseId
        )
        const isRemoteBase =
          editingBase.remote === true || (ownedBinding?.id === targetLocalBaseId && ownedBinding.localBaseId == null)
        const remoteBaseId = isRemoteBase ? targetLocalBaseId : ownedBinding?.id
        if (!isRemoteBase) {
          await updateBase(targetLocalBaseId, { name: normalized })
        }

        // 期间若账号切换（session 自增）则终止并关闭弹窗，避免对错误账号重试云端改名。
        if (capturedSession !== orgSessionRef.current) {
          setEditingBase(null)
          return
        }

        if (remoteBaseId) {
          try {
            await ipcApi.request('enterprise.knowledge.rename_shared', {
              baseId: remoteBaseId,
              name: normalized
            })
          } catch (error) {
            // 本地已改名、云端失败：保留弹窗、不回滚本地，提示用户可重试。
            const reason =
              error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? ` [${error.code}]`
                : ''
            toast.error(
              `${formatErrorMessageWithPrefix(error, t('knowledge.org.rename_shared_cloud_failed'))}${reason}`
            )
            return
          }

          try {
            await org.refresh()
          } catch (error) {
            toast.error(formatErrorMessageWithPrefix(error, t('common.refresh_failed')))
          }
        }

        setEditingBase(null)
      } finally {
        setIsRenamingBase(false)
      }
    },
    [editingBase, isRenamingBase, org.catalog.owned, org.refresh, t, updateBase]
  )
  // 旧替换代码（保留注释）：submitRenameBase 仅本地 updateBase 后关闭弹窗，不同步云端。
  // const submitRenameBase = useCallback(
  //   async (name: string) => {
  //     if (!editingBase) {
  //       return
  //     }
  //     if (name === editingBase.name.trim()) {
  //       setEditingBase(null)
  //       return
  //     }
  //     await updateBase(editingBase.id, { name })
  //     setEditingBase(null)
  //   },
  //   [editingBase, updateBase]
  // )

  const submitRenameGroup = useCallback(
    async (name: string) => {
      if (!editingGroup) {
        return
      }

      if (name === editingGroup.name.trim()) {
        setEditingGroup(null)
        return
      }

      await updateGroup(editingGroup.id, { name })
      setEditingGroup(null)
    },
    [editingGroup, updateGroup]
  )

  const handleDeleteBase = useCallback(
    async (baseId: string) => {
      try {
        await deleteBase(baseId)
      } catch (error) {
        toast.error(formatErrorMessageWithPrefix(error, t('knowledge.error.failed_to_delete')))
      }
    },
    [deleteBase, t]
  )

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      try {
        await ipcApi.request('enterprise.knowledge.remove_local_group', { groupId })
        await deleteGroup(groupId)
      } catch (error) {
        toast.error(formatErrorMessageWithPrefix(error, t('knowledge.groups.error.failed_to_delete')))
      }
    },
    [deleteGroup, t]
  )

  const value = useMemo<KnowledgePageContextValue>(
    () => ({
      org,
      category,
      setCategory,
      selectedOrgBase,
      selectOrgBase,
      orgSession,
      handleOrgUnshared,
      bases,
      groups,
      isLoading,
      selectedBase,
      selectedBaseId,
      selectedItemId,
      selectedItemView,
      filePreview,
      baseNavigationVersion,
      activeTab,
      contentRef,
      editingBase,
      editingGroup,
      restoringBase,
      restoreBaseInitialValues,
      isAddSourceDialogOpen,
      pendingAddSource,
      pendingAddFiles,
      isRagConfigDrawerOpen,
      isRecallTestDrawerOpen,
      isCreateBaseDialogOpen,
      isCreateGroupDialogOpen,
      createBaseInitialGroupId,
      isCreatingBase,
      isCreatingGroup,
      isUpdatingBase: isUpdatingLocalBase || isRenamingBase,
      isUpdatingGroup,
      isRestoringBase,
      createBase,
      restoreBase,
      selectBase,
      setActiveTab: handleSetActiveTab,
      openItemChunks,
      openItemContent,
      closeItemChunks,
      openFilePreview,
      closeFilePreview: resetFilePreview,
      openAddSourceDialog,
      openRagConfigDrawer,
      openRecallTestDrawer,
      handleRagConfigDrawerOpenChange,
      handleRecallTestDrawerOpenChange,
      openCreateBaseDialog,
      openCreateGroupDialog,
      openRenameBaseDialog,
      openRenameGroupDialog,
      openRestoreBaseDialog,
      handleAddSourceDialogOpenChange,
      handleCreateBaseDialogOpenChange,
      handleCreateGroupDialogOpenChange,
      handleRenameBaseDialogOpenChange,
      handleRenameGroupDialogOpenChange,
      handleRestoreBaseDialogOpenChange,
      handleCreateBaseCreated,
      handleRestoreBaseRestored,
      submitCreateGroup,
      submitRenameBase,
      submitRenameGroup,
      moveBase,
      deleteBase: handleDeleteBase,
      deleteGroup: handleDeleteGroup
    }),
    [
      org,
      category,
      setCategory,
      selectedOrgBase,
      selectOrgBase,
      orgSession,
      handleOrgUnshared,
      activeTab,
      baseNavigationVersion,
      bases,
      createBase,
      editingBase,
      editingGroup,
      restoringBase,
      restoreBaseInitialValues,
      groups,
      handleAddSourceDialogOpenChange,
      handleCreateBaseCreated,
      handleCreateBaseDialogOpenChange,
      handleCreateGroupDialogOpenChange,
      handleDeleteBase,
      handleDeleteGroup,
      handleSetActiveTab,
      handleRenameBaseDialogOpenChange,
      handleRenameGroupDialogOpenChange,
      handleRestoreBaseDialogOpenChange,
      handleRestoreBaseRestored,
      isAddSourceDialogOpen,
      pendingAddFiles,
      pendingAddSource,
      isRagConfigDrawerOpen,
      isRecallTestDrawerOpen,
      handleRagConfigDrawerOpenChange,
      handleRecallTestDrawerOpenChange,
      openRagConfigDrawer,
      openRecallTestDrawer,
      isCreateBaseDialogOpen,
      isCreateGroupDialogOpen,
      createBaseInitialGroupId,
      isCreatingBase,
      isCreatingGroup,
      isLoading,
      isRenamingBase,
      isUpdatingLocalBase,
      isUpdatingGroup,
      isRestoringBase,
      filePreview,
      moveBase,
      openAddSourceDialog,
      closeItemChunks,
      openFilePreview,
      openItemChunks,
      openItemContent,
      openCreateBaseDialog,
      openCreateGroupDialog,
      openRenameBaseDialog,
      openRenameGroupDialog,
      openRestoreBaseDialog,
      restoreBase,
      resetFilePreview,
      selectBase,
      selectedBase,
      selectedBaseId,
      selectedItemId,
      selectedItemView,
      submitCreateGroup,
      submitRenameBase,
      submitRenameGroup
    ]
  )

  return <KnowledgePageContext value={value}>{children}</KnowledgePageContext>
}

export const useKnowledgePage = () => {
  const context = use(KnowledgePageContext)

  if (!context) {
    throw new Error('useKnowledgePage must be used within KnowledgePageProvider')
  }

  return context
}
