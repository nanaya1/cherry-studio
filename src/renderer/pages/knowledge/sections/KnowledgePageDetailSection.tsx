import { ArrowLeft, ChevronDown } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, PageSidePanel, Tooltip } from '@cherrystudio/ui'
import { CommandPopupMenu } from '@renderer/components/command'
import { FilePreview } from '@renderer/components/FilePreview'
import { useDeleteKnowledgeItem, useKnowledgeItems, useReindexKnowledgeItem } from '@renderer/hooks/useKnowledgeItems'
import { toast } from '@renderer/services/toast'
import type { KnowledgeItemOf } from '@shared/data/types/knowledge'

import DetailHeader from '../components/DetailHeader'
import KnowledgeSharingPanel from '../components/KnowledgeSharingPanel'
// import KnowledgeSyncBadge from '../components/KnowledgeSyncBadge'
import KnowledgeSyncDialog from '../components/KnowledgeSyncDialog'
import { useKnowledgeUpload } from '../components/KnowledgeUploadDetails'
import ShareKnowledgeDialog from '../components/ShareKnowledgeDialog'
import { useKnowledgeSyncStatus } from '../hooks/useKnowledgeSyncStatus'
import { useKnowledgePage } from '../KnowledgePageProvider'
import DataSourcePanel from '../panels/dataSource/DataSourcePanel'
import { areKnowledgeItemsReady } from '../utils/sharing'

// Item detail views are loaded when an item is opened, not with the page.
const KnowledgeItemChunkDetailPanel = lazy(() => import('../panels/dataSource/KnowledgeItemChunkDetailPanel'))
const KnowledgeItemNoteContentPanel = lazy(() => import('../panels/dataSource/KnowledgeItemNoteContentPanel'))

const RagConfigPanel = lazy(() => import('../panels/ragConfig/RagConfigPanel'))
const RecallTestPanel = lazy(() => import('../panels/recallTest/RecallTestPanel'))

// const KnowledgePageDetailSection = () => {
const KnowledgePageDetailSection = ({ onSharingChange }: { onSharingChange?: (open: boolean) => void }) => {
  const { t } = useTranslation()
  const { org, orgSession } = useKnowledgePage()
  // const [sharing, setSharing] = useState(false)
  const [sharing, setSharing] = useState<false | 'code' | 'people'>(false)
  const [awaitingUpload, setAwaitingUpload] = useState(false)
  const inviteHostActive = useRef(true)
  useEffect(() => {
    inviteHostActive.current = true
    return () => {
      inviteHostActive.current = false
    }
  }, [])
  // 后台上传和弹窗恢复期间也保留宿主，避免目录刷新切换到云端详情。
  useEffect(() => {
    onSharingChange?.(sharing !== false || awaitingUpload)
  }, [sharing, awaitingUpload, onSharingChange])
  const [records, setRecords] = useState(false)
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    setSharing(false)
    setRecords(false)
    setSyncing(false)
  }, [orgSession])
  const {
    selectedBase,
    selectedBaseId,
    selectedItemId,
    selectedItemView,
    filePreview,
    baseNavigationVersion,
    isRagConfigDrawerOpen,
    isRecallTestDrawerOpen,
    openItemChunks,
    openItemContent,
    closeItemChunks,
    openFilePreview,
    closeFilePreview,
    openAddSourceDialog,
    openRagConfigDrawer,
    openRecallTestDrawer,
    handleRagConfigDrawerOpenChange,
    handleRecallTestDrawerOpenChange,
    openRestoreBaseDialog
  } = useKnowledgePage()

  const upload = useKnowledgeUpload(selectedBaseId, Boolean(selectedBaseId))
  const handledUploadState = useRef<string | null>(null)
  const observedUpload = useRef(false)
  const sharingModeBeforeClose = useRef<false | 'code' | 'people'>(false)
  const [autoRestoreSharing, setAutoRestoreSharing] = useState(false)
  const sharedCopy = org.catalog.owned.find((base) => base.localBaseId === selectedBaseId)
  const sync = useKnowledgeSyncStatus(selectedBaseId, baseNavigationVersion)
  useEffect(() => {
    if (!upload) return
    if (['preparing', 'counting', 'uploading', 'confirming'].includes(upload.phase)) observedUpload.current = true
    if (
      upload.phase === 'completed' &&
      (awaitingUpload || observedUpload.current) &&
      sharing === false &&
      handledUploadState.current !== `${selectedBaseId}:completed`
    ) {
      handledUploadState.current = `${selectedBaseId}:completed`
      void org.refresh()
      if (sharingModeBeforeClose.current !== 'people') {
        setAutoRestoreSharing(true)
        setSharing('code')
        setAwaitingUpload(false)
      }
    }
    if (['paused', 'cleanup_pending', 'cleanup_unknown'].includes(upload.phase) && upload.error) {
      const stateKey = `${selectedBaseId}:${upload.phase}:${upload.error}`
      if (handledUploadState.current !== stateKey) {
        handledUploadState.current = stateKey
        toast.error(upload.error)
      }
    }
  }, [selectedBaseId, sharing, upload, awaitingUpload, org])
  useEffect(() => {
    setAutoRestoreSharing(false)
    setAwaitingUpload(false)
    handledUploadState.current = null
    observedUpload.current = false
    sharingModeBeforeClose.current = false
    setSharing(false)
    setRecords(false)
    setSyncing(false)
  }, [selectedBaseId])

  // Directory drill-down: the stack holds the directory items descended into (empty = base root).
  // The current directory's id becomes the item-list's `groupId`, listing that folder's children.
  const [directoryStack, setDirectoryStack] = useState<KnowledgeItemOf<'directory'>[]>([])
  const currentDirectory = directoryStack.at(-1) ?? null

  // Every base selection starts from that base's root, including re-selecting the current base.
  useEffect(() => {
    setDirectoryStack([])
  }, [baseNavigationVersion])

  const drillIntoDirectory = useCallback((item: KnowledgeItemOf<'directory'>) => {
    setDirectoryStack((prev) => [...prev, item])
  }, [])
  const navigateUp = useCallback(() => {
    setDirectoryStack((prev) => prev.slice(0, -1))
  }, [])

  const {
    items: selectedBaseItems,
    total: selectedBaseItemsTotal,
    isLoading: isItemsLoading,
    hasMore: hasMoreItems,
    isLoadingMore: isLoadingMoreItems,
    loadMore: loadMoreItems
  } = useKnowledgeItems(selectedBaseId, currentDirectory?.id ?? null)
  const {
    items: rootItems,
    total: rootItemsTotal,
    isLoading: isRootItemsLoading,
    hasMore: hasMoreRootItems,
    isLoadingMore: isLoadingMoreRootItems,
    loadMore: loadMoreRootItems
  } = useKnowledgeItems(selectedBaseId)
  useEffect(() => {
    if (hasMoreRootItems && !isLoadingMoreRootItems) {
      loadMoreRootItems()
    }
  }, [hasMoreRootItems, isLoadingMoreRootItems, loadMoreRootItems])
  const { deleteItem, deleteItems } = useDeleteKnowledgeItem(selectedBaseId)
  const { reindexItem, reindexItems } = useReindexKnowledgeItem(selectedBaseId)
  const canShare = areKnowledgeItemsReady(rootItems, rootItemsTotal, isRootItemsLoading)
  const shareDisabledReason = isRootItemsLoading
    ? t('knowledge.org.share_disabled_loading')
    : rootItemsTotal === 0
      ? t('knowledge.org.share_disabled_empty')
      : t('knowledge.org.share_disabled_not_ready')

  if (!selectedBase) {
    return null
  }

  return (
    <main data-ui="knowledge.content" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!selectedItemId && !filePreview ? (
        <DetailHeader
          base={selectedBase}
          sharingStatus={
            <Badge variant="outline" className="shrink-0 text-xs font-normal">
              {/* {t(sharedCopy ? 'knowledge.org.shared_tag' : 'knowledge.sync.state.unshared')} */}
              {t(sharedCopy?.shareCompleted ? 'knowledge.org.shared_tag' : 'knowledge.sync.state.unshared')}
            </Badge>
          }
          actions={
            <>
              <Button variant="ghost" size="sm" disabled={!sharedCopy} onClick={() => setRecords(true)}>
                {t('knowledge.org.shares')}
              </Button>
              <Tooltip content={canShare ? undefined : shareDisabledReason} placement="bottom">
                <CommandPopupMenu
                  location="webcontents.context"
                  align="end"
                  side="bottom"
                  disabled={!canShare}
                  extraItems={[
                    {
                      type: 'item',
                      id: 'share-code',
                      label: t('knowledge.org.share_code'),
                      onSelect: () => {
                        sharingModeBeforeClose.current = 'code'
                        setSharing('code')
                      }
                    },
                    {
                      type: 'item',
                      id: 'invite-people',
                      label: t('knowledge.org.invite_people'),
                      onSelect: () => {
                        sharingModeBeforeClose.current = 'people'
                        setSharing('people')
                      }
                    }
                  ]}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canShare}
                    className="disabled:pointer-events-auto disabled:cursor-default">
                    {t('knowledge.org.share')}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </CommandPopupMenu>
              </Tooltip>
            </>
          }
          onOpenRagConfig={openRagConfigDrawer}
          onOpenRecallTest={openRecallTestDrawer}
          onRebuild={() => openRestoreBaseDialog(selectedBase)}
        />
      ) : null}

      <div className="hidden">
        {/* <Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
          {t('knowledge.org.share')}
        </Button> */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            sharingModeBeforeClose.current = 'code'
            setSharing('code')
          }}>
          {t('knowledge.org.share_code')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            sharingModeBeforeClose.current = 'people'
            setSharing('people')
          }}>
          {t('knowledge.org.invite_people')}
        </Button>
        {/* 手动同步入口暂时隐藏，保留现有同步流程。
        <Button
          variant="ghost"
          size="sm"
          disabled={!sync.status || sync.status.state === 'unshared'}
          onClick={() => setSyncing(true)}>
          {t('knowledge.sync.title')}
        </Button>
        <Button variant="ghost" size="sm" disabled={!sharedCopy} onClick={() => setRecords(true)}>
          {t('knowledge.org.shares')}
        </Button>
        {sync.status ? <KnowledgeSyncBadge status={sync.status} /> : null}
        */}
        {sync.error ? (
          <Button variant="ghost" size="sm" title={sync.error} onClick={() => void sync.refresh()}>
            {t('knowledge.sync.status_unavailable')}
          </Button>
        ) : null}
      </div>
      <PageSidePanel
        open={records && !!sharedCopy}
        onClose={() => setRecords(false)}
        title={t('knowledge.org.shares')}
        closeLabel={t('common.close')}>
        {records && sharedCopy ? (
          <KnowledgeSharingPanel
            key={`${orgSession}-${selectedBaseId}`}
            baseId={sharedCopy.id}
            name={selectedBase.name}
            localBaseId={sharedCopy.localBaseId}
            canCreateShare={Boolean(sharedCopy.localBaseId) && sharedCopy.shareCompleted === true}
            onUnshared={() => {
              void org.refresh()
              void sync.refresh()
              setRecords(false)
            }}
          />
        ) : null}
      </PageSidePanel>
      {syncing ? (
        <KnowledgeSyncDialog
          key={`${orgSession}-${selectedBaseId}`}
          baseId={selectedBaseId}
          name={selectedBase.name}
          onClose={() => setSyncing(false)}
          onSynced={() => {
            void sync.refresh()
            void org.refresh()
          }}
        />
      ) : null}
      {sharing ? (
        <ShareKnowledgeDialog
          key={`${orgSession}-${selectedBaseId}-${sharing}`}
          mode={sharing}
          autoGenerate={autoRestoreSharing}
          canContinueInvite={() => inviteHostActive.current}
          onInviteSettled={() => {
            if (inviteHostActive.current) setAwaitingUpload(false)
          }}
          onUploadStarted={() => {
            sharingModeBeforeClose.current = sharing
            handledUploadState.current = null
            setAwaitingUpload(true)
          }}
          baseId={selectedBaseId}
          name={selectedBase.name}
          onClose={() => {
            sharingModeBeforeClose.current = sharing
            setSharing(false)
            void sync.refresh()
          }}
          onShared={() => {
            handledUploadState.current = `${selectedBaseId}:completed`
            setAwaitingUpload(false)
            void org.refresh()
            void sync.refresh()
          }}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden px-3 pt-3 pb-4">
        {selectedItemId ? (
          <Suspense fallback={null}>
            {selectedItemView === 'content' ? (
              <KnowledgeItemNoteContentPanel itemId={selectedItemId} onBack={closeItemChunks} />
            ) : (
              <KnowledgeItemChunkDetailPanel baseId={selectedBaseId} itemId={selectedItemId} onBack={closeItemChunks} />
            )}
          </Suspense>
        ) : filePreview ? (
          <section
            aria-label={filePreview.fileName}
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <FilePreview
              filePath={filePreview.filePath}
              header={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('common.back')}
                    className="size-6 min-h-6 min-w-6 rounded p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                    onClick={closeFilePreview}>
                    <ArrowLeft className="size-3.5" />
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-foreground text-sm">{filePreview.fileName}</span>
                </>
              }
            />
          </section>
        ) : (
          <DataSourcePanel
            embeddingModelId={selectedBase.embeddingModelId}
            items={selectedBaseItems}
            total={selectedBaseItemsTotal}
            isLoading={isItemsLoading}
            hasMore={hasMoreItems}
            isLoadingMore={isLoadingMoreItems}
            onLoadMore={loadMoreItems}
            updatedAt={selectedBase.updatedAt}
            onAdd={openAddSourceDialog}
            onPreviewFile={openFilePreview}
            onItemClick={openItemChunks}
            onViewNoteContent={openItemContent}
            onDrillIntoDirectory={drillIntoDirectory}
            currentDirectory={currentDirectory}
            onNavigateUp={navigateUp}
            onDelete={deleteItem}
            onDeleteItems={deleteItems}
            onReindex={reindexItem}
            onReindexItems={reindexItems}
          />
        )}
      </div>

      <PageSidePanel
        open={isRagConfigDrawerOpen}
        onClose={() => handleRagConfigDrawerOpenChange(false)}
        title={t('knowledge.tabs.rag_config')}
        closeLabel={t('common.close')}
        bodyClassName="px-0 py-0">
        {isRagConfigDrawerOpen ? (
          <Suspense fallback={null}>
            <RagConfigPanel
              base={selectedBase}
              itemCount={isItemsLoading ? undefined : selectedBaseItemsTotal}
              onRestoreBase={openRestoreBaseDialog}
            />
          </Suspense>
        ) : null}
      </PageSidePanel>

      <PageSidePanel
        open={isRecallTestDrawerOpen}
        onClose={() => handleRecallTestDrawerOpenChange(false)}
        title={t('knowledge.tabs.recall_test')}
        closeLabel={t('common.close')}
        bodyClassName="px-0 py-0">
        {isRecallTestDrawerOpen ? (
          <Suspense fallback={null}>
            <RecallTestPanel baseId={selectedBaseId} />
          </Suspense>
        ) : null}
      </PageSidePanel>
    </main>
  )
}

export default KnowledgePageDetailSection
