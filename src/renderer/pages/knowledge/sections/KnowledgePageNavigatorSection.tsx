import { type MouseEvent as ReactMouseEvent, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { useResizeDrag } from '@renderer/hooks/useResizeDrag'

import KnowledgeInvitations from '../components/KnowledgeInvitations'
import { BaseNavigator } from '../components/navigator'
import ReceiveKnowledgeShareDialog from '../components/ReceiveKnowledgeShareDialog'
import { useKnowledgePage } from '../KnowledgePageProvider'

const NAVIGATOR_DEFAULT_WIDTH = 250
const NAVIGATOR_MIN_WIDTH = 220
const NAVIGATOR_MAX_WIDTH = 360

const KnowledgePageNavigatorSection = () => {
  const { t } = useTranslation()
  const { org, orgSession, category, setCategory, selectedOrgBase, selectOrgBase } = useKnowledgePage()
  const [receiving, setReceiving] = useState(false)
  const orgBases = category === 'local' ? [] : org.catalog[category]
  const {
    bases,
    groups,
    isLoading,
    contentRef,
    selectedBaseId,
    selectBase,
    openCreateGroupDialog,
    openCreateBaseDialog,
    moveBase,
    openRenameBaseDialog,
    openRenameGroupDialog,
    deleteGroup,
    deleteBase
  } = useKnowledgePage()
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
    <BaseNavigator
      header={
        <div className="mb-4 flex shrink-0 items-center gap-1 border-b border-border pb-3">
          {(['local', 'public', 'shared'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={category === value ? 'secondary' : 'ghost'}
              className="min-w-0 flex-1 rounded-md px-1 text-xs"
              aria-pressed={category === value}
              onClick={() => setCategory(value)}>
              {t(
                { local: 'knowledge.org.local', public: 'knowledge.org.public', shared: 'knowledge.org.shared' }[value]
              )}
            </Button>
          ))}
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
            {category === 'shared' ? <KnowledgeInvitations key={orgSession} onChanged={org.refresh} /> : null}
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
                className="h-auto min-h-12 w-full justify-start rounded-lg whitespace-normal px-3 py-3 text-left"
                aria-pressed={selectedOrgBase?.id === base.id}
                onClick={() => selectOrgBase(base)}>
                {base.name}
              </Button>
            ))}
          </div>
        )
      }
      sharedBaseIds={new Set(org.catalog.owned.flatMap((base) => (base.localBaseId ? [base.localBaseId] : [])))}
      bases={bases}
      groups={groups}
      isLoading={isLoading}
      width={navigatorWidth}
      selectedBaseId={selectedBaseId}
      onSelectBase={selectBase}
      onCreateGroup={openCreateGroupDialog}
      onCreateBase={openCreateBaseDialog}
      onMoveBase={moveBase}
      onRenameBase={openRenameBaseDialog}
      onRenameGroup={openRenameGroupDialog}
      onDeleteGroup={deleteGroup}
      onDeleteBase={deleteBase}
      onResizeStart={startNavigatorResize}
    />
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
