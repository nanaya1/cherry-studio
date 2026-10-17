import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// import { Button } from '@cherrystudio/ui'
// import { Button, PageSidePanel } from '@cherrystudio/ui'
import { Button } from '@cherrystudio/ui'
import { useResizeDrag } from '@renderer/hooks/useResizeDrag'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { parseOrgId } from '@shared/data/types/enterpriseKnowledge'

import KnowledgeInvitations from '../components/KnowledgeInvitations'
import { BaseNavigator, type BaseNavigatorRemoteRow } from '../components/navigator'
import ReceiveKnowledgeShareDialog from '../components/ReceiveKnowledgeShareDialog'
// import KnowledgeSharingPanel from '../components/KnowledgeSharingPanel'
import UnshareKnowledgeDialog from '../components/UnshareKnowledgeDialog'
import { useKnowledgePage } from '../KnowledgePageProvider'

const NAVIGATOR_DEFAULT_WIDTH = 250
const NAVIGATOR_MIN_WIDTH = 220
const NAVIGATOR_MAX_WIDTH = 360

const KnowledgePageNavigatorSection = () => {
  const { t } = useTranslation()
  const { org, orgSession, category, setCategory, selectedOrgBase, selectOrgBase } = useKnowledgePage()
  const [receiving, setReceiving] = useState(false)
  const [unshareBaseId, setUnshareBaseId] = useState<string | null>(null)
  const [deleteLocal, setDeleteLocal] = useState(false)
  const [pendingCleanup, setPendingCleanup] = useState<Array<{ baseId: string; localBaseId: string }>>([])
  useEffect(() => {
    let active = true
    setPendingCleanup([])
    void ipcApi
      .request('enterprise.knowledge.pending_cleanup')
      .then((value) => {
        if (active) setPendingCleanup(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [orgSession, org.catalog.owned, unshareBaseId])
  const [spaceGroups, setSpaceGroups] = useState<Record<string, string>>({})
  const sessionRef = useRef(orgSession)
  sessionRef.current = orgSession
  const unshareCopy = org.catalog.owned.find((base) => base.id === unshareBaseId || base.localBaseId === unshareBaseId)
  // const orgBases = category === 'local' ? [] : [...new Map([...org.catalog[category], ...org.catalog.owned].map((base) => [base.id, base])).values()]
  // MEA:enterprise-knowledge-page owned 只归本地，公共与分享使用服务端各自目录。
  const orgBases = category === 'local' ? [] : org.catalog[category]
  const {
    bases,
    groups,
    isLoading,
    contentRef,
    selectedBaseId,
    selectBase,
    handleOrgUnshared,
    openCreateGroupDialog,
    openCreateBaseDialog,
    moveBase,
    openRenameBaseDialog,
    openRenameGroupDialog,
    deleteGroup,
    deleteBase
  } = useKnowledgePage()
  useEffect(() => {
    let active = true
    setSpaceGroups({})
    void ipcApi
      .request('enterprise.knowledge.local_groups')
      .then((value) => {
        if (active) setSpaceGroups(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [orgSession, groups, org.catalog.owned])
  const remoteRows: BaseNavigatorRemoteRow[] =
    category === 'local'
      ? org.catalog.owned
          // 归属采用服务端 owned 分类；分享关系失效或查询失败不应隐藏本人云端库。
          // 原过滤条件：(base.hasShareEvidence === true || base.shareCompleted === true) &&
          .filter((base) => !bases.some((local) => local.id === base.localBaseId))
          .map((base) => ({
            id: base.id,
            name: base.name,
            selected: selectedOrgBase?.id === base.id,
            onSelect: () => selectOrgBase(base),
            tag: t('knowledge.org.shared_tag'),
            groupId: groups.some((group) => group.id === spaceGroups[parseOrgId(base.id) ?? ''])
              ? spaceGroups[parseOrgId(base.id) ?? '']
              : null,
            onMove: (groupId) => {
              const session = orgSession
              void moveBase(base.id, groupId).then(async () => {
                if (sessionRef.current !== session) return
                const value = await ipcApi.request('enterprise.knowledge.local_groups')
                if (sessionRef.current === session) setSpaceGroups(value)
              })
            },
            onCreateGroup: () => openCreateGroupDialog(base.id),
            onRename: () => {
              openRenameBaseDialog({ id: base.localBaseId ?? base.id, name: base.name, remote: true })
            },
            onUnshare: () => {
              setDeleteLocal(false)
              setUnshareBaseId(base.id)
            },
            onDelete: () => {
              setDeleteLocal(true)
              setUnshareBaseId(base.id)
            }
          }))
      : []
  const [navigatorWidth, setNavigatorWidth] = useState(NAVIGATOR_DEFAULT_WIDTH)
  const contentLeftRef = useRef(0)

  const handleNavigatorResizeMove = useCallback((moveEvent: MouseEvent) => {
    const nextWidth = moveEvent.clientX - contentLeftRef.current
    setNavigatorWidth(Math.min(NAVIGATOR_MAX_WIDTH, Math.max(NAVIGATOR_MIN_WIDTH, nextWidth)))
  }, [])

  const { startResizing: startNavigatorResizeDrag } = useResizeDrag({ onMove: handleNavigatorResizeMove })

  const startNavigatorResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      contentLeftRef.current = contentRef.current?.getBoundingClientRect().left ?? 0
      startNavigatorResizeDrag(event)
    },
    [contentRef, startNavigatorResizeDrag]
  )

  return (
    <>
      {category === 'local' && Array.isArray(pendingCleanup)
        ? pendingCleanup.map((operation) => (
            <Button
              key={operation.baseId}
              variant="outline"
              onClick={async () => {
                const session = orgSession
                try {
                  const result = await ipcApi.request('enterprise.knowledge.cleanup_local', {
                    baseId: operation.baseId,
                    localBaseId: operation.localBaseId
                  })
                  if (sessionRef.current !== session) return
                  if (!result.ok || result.localBaseId !== operation.localBaseId)
                    throw new Error(t('knowledge.org.operation_failed'))
                  setPendingCleanup((pending) => pending.filter((item) => item.baseId !== operation.baseId))
                  handleOrgUnshared()
                } catch (error) {
                  if (sessionRef.current === session) {
                    setPendingCleanup((pending) =>
                      pending.some((item) => item.baseId === operation.baseId) ? pending : [...pending, operation]
                    )
                    toast.error(error instanceof Error ? error.message : String(error))
                  }
                }
              }}>
              {t('knowledge.org.cleanup_continue')} ·{' '}
              {bases.find((base) => base.id === operation.localBaseId)?.name ?? t('knowledge.org.recovery_prepare')}
            </Button>
          ))
        : null}
      {/* <PageSidePanel
        open={!!unshareCopy}
        onClose={() => setUnshareBaseId(null)}
        title={t('knowledge.org.unshare')}
        closeLabel={t('common.close')}>
        {unshareCopy && unshareBaseId ? (
          <KnowledgeSharingPanel
            key={`${orgSession}-${unshareBaseId}`}
            baseId={unshareCopy.id}
            localBaseId={unshareBaseId}
            name={unshareCopy.name}
            confirmUnshare
            onUnshared={() => {
              setUnshareBaseId(null)
              void org.refresh()
            }}
          />
        ) : null}
      </PageSidePanel> */}
      {unshareCopy && unshareBaseId ? (
        <UnshareKnowledgeDialog
          key={`${orgSession}-${unshareBaseId}`}
          baseId={unshareCopy.id}
          deleteLocal={deleteLocal}
          name={unshareCopy.name}
          onClose={() => setUnshareBaseId(null)}
          onUnshared={handleOrgUnshared}
        />
      ) : null}
      <BaseNavigator
        onRequestUnshare={(baseId) => {
          setDeleteLocal(false)
          setUnshareBaseId(baseId)
        }}
        header={
          <div className="shrink-0">
            {/* <h1 className="px-3 pt-1 pb-5 text-lg font-semibold tracking-tight">{t('knowledge.title')}</h1> */}
            <div className="mb-4 flex items-center gap-1 border-b border-border pb-3">
              {(['local', 'public', 'shared'] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={category === value ? 'secondary' : 'ghost'}
                  className="min-w-0 flex-1 rounded-md px-1 text-xs"
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}>
                  {t(
                    { local: 'knowledge.org.local', public: 'knowledge.org.public', shared: 'knowledge.org.shared' }[
                      value
                    ]
                  )}
                </Button>
              ))}
            </div>
          </div>
        }
        content={
          category === 'local' ? undefined : (
            <div className="min-h-0 flex-1 space-y-2 overflow-auto">
              {category === 'shared' ? (
                <Button variant="outline" className="w-full" onClick={() => setReceiving(true)}>
                  {t('knowledge.org.add_with_code')}
                </Button>
              ) : null}
              {category === 'shared' ? (
                <KnowledgeInvitations
                  key={orgSession}
                  onChanged={org.refresh}
                  onAddWithCode={() => setReceiving(true)}
                />
              ) : null}
              {receiving && category === 'shared' ? (
                <ReceiveKnowledgeShareDialog
                  key={orgSession}
                  onClose={() => setReceiving(false)}
                  onReceived={async (received) => {
                    selectOrgBase({ id: received.baseId, name: received.name, description: null })
                    await org.refresh()
                  }}
                />
              ) : null}
              {org.loading ? (
                <p role="status" className="p-2 text-muted-foreground">
                  {t('common.loading')}
                </p>
              ) : null}
              {org.error ? (
                <div role="alert" className="p-2">
                  <p className="break-words text-error">{org.error}</p>
                  <Button variant="ghost" onClick={() => void org.refresh()}>
                    {t('knowledge.org.refresh')}
                  </Button>
                </div>
              ) : null}
              {!org.loading && !org.error && orgBases.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">{t('knowledge.org.empty_bases')}</p>
              ) : null}
              {orgBases.map((base) => (
                <Button
                  key={base.id}
                  variant={selectedOrgBase?.id === base.id ? 'secondary' : 'ghost'}
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                  aria-pressed={selectedOrgBase?.id === base.id}
                  onClick={() => selectOrgBase(base)}>
                  {base.name}
                </Button>
              ))}
            </div>
          )
        }
        remoteRows={remoteRows}
        sharedBaseIds={
          new Set(
            org.catalog.owned.flatMap((base) => (base.localBaseId && base.shareCompleted ? [base.localBaseId] : []))
          )
        }
        // 远端 owned 行已由 remoteRows 集成到本地主滚动区；保留旧 footer 位置为空，避免恢复为独立列表。
        footer={null}
        bases={bases}
        groups={groups}
        isLoading={isLoading}
        width={navigatorWidth}
        // selectedBaseId={selectedBaseId}
        selectedBaseId={selectedOrgBase ? (selectedOrgBase.localBaseId ?? '') : selectedBaseId}
        onSelectBase={selectBase}
        onCreateGroup={openCreateGroupDialog}
        onCreateBase={openCreateBaseDialog}
        onMoveBase={moveBase}
        onRenameBase={openRenameBaseDialog}
        onRenameGroup={openRenameGroupDialog}
        onDeleteGroup={deleteGroup}
        onDeleteBase={(baseId) => {
          const owned = org.catalog.owned.find((base) => base.localBaseId === baseId || base.id === baseId)
          if (owned) {
            setDeleteLocal(true)
            setUnshareBaseId(owned.id)
            return
          }
          return deleteBase(baseId)
        }}
        onResizeStart={startNavigatorResize}
      />
    </>
  )
}

export default KnowledgePageNavigatorSection

/* 独立副本列表已收起，分享记录移至本地知识库详情。
      footer={
        category === 'local' ? (
          <section
            aria-label={t('knowledge.org.owned_copies')}
            className="max-h-[40%] shrink-0 overflow-auto border-t border-border pt-2">
            <h3 className="px-2 text-sm font-medium text-muted-foreground">{t('knowledge.org.owned_copies')}</h3>
            {org.loading ? (
              <p role="status" className="p-2">
                {t('common.loading')}
              </p>
            ) : null}
            {org.error ? (
              <div role="alert" className="p-2">
                <p className="break-words text-error">{org.error}</p>
                <Button variant="ghost" onClick={() => void org.refresh()}>
                  {t('knowledge.org.refresh')}
                </Button>
              </div>
            ) : null}
            {!org.loading && !org.error && org.catalog.owned.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">{t('knowledge.org.empty_bases')}</p>
            ) : null}
            {org.catalog.owned.map((base) => (
              <Button
                key={base.id}
                variant={selectedOrgBase?.id === base.id ? 'secondary' : 'ghost'}
                className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                aria-pressed={selectedOrgBase?.id === base.id}
                onClick={() => selectOrgBase(base)}>
                {base.name}
              </Button>
            ))}
          </section>
        ) : null
      }
*/
