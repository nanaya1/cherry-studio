import { useTranslation } from 'react-i18next'

// 待处理邀请入口移至左侧导航。
// import KnowledgeInvitations from './components/KnowledgeInvitations'
import KnowledgeSharingPanel from './components/KnowledgeSharingPanel'
import OrgKnowledgeDetail from './components/OrgKnowledgeDetail'
import { KnowledgePageProvider, useKnowledgePage } from './KnowledgePageProvider'
import KnowledgePageDetailSection from './sections/KnowledgePageDetailSection'
import KnowledgePageDialogSection from './sections/KnowledgePageDialogSection'
import KnowledgePageEmptyStateSection from './sections/KnowledgePageEmptyStateSection'
import KnowledgePageNavigatorSection from './sections/KnowledgePageNavigatorSection'
import KnowledgePageShell from './sections/KnowledgePageShell'

const KnowledgePageContent = () => {
  const { t } = useTranslation()
  const { filePreview, selectedBase, isLoading, org, category, selectedOrgBase, orgSession } = useKnowledgePage()

  const managingCopy = category === 'local' && selectedOrgBase !== undefined

  // MEA:enterprise-knowledge-page 空本地目录也保留组织导航。
  // if (!isLoading && bases.length === 0) return <KnowledgePageEmptyStateSection />

  return (
    <KnowledgePageShell>
      <div
        className={filePreview && category === 'local' && !managingCopy ? 'hidden' : 'contents'}
        hidden={Boolean(filePreview && category === 'local' && !managingCopy)}>
        <KnowledgePageNavigatorSection />
      </div>
      {managingCopy ? (
        <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
          <h2 className="mb-4 font-medium">
            {selectedOrgBase.name} · {t('knowledge.org.shares')}
          </h2>
          <KnowledgeSharingPanel
            key={`${orgSession}-${selectedOrgBase.id}`}
            baseId={selectedOrgBase.id}
            name={selectedOrgBase.name}
          />
        </main>
      ) : category !== 'local' ? (
        <div key={orgSession} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {/* MEA:enterprise-knowledge-page 分享码领取与指定人邀请并存。 */}
          {/* {category === 'shared' ? <KnowledgeInvitations onChanged={org.refresh} /> : null} */}
          {/* 邀请在左侧独立弹窗中处理，详情区仅展示选中知识库。 */}
          {selectedOrgBase ? (
            <OrgKnowledgeDetail
              key={selectedOrgBase.id}
              base={selectedOrgBase}
              owned={org.catalog.owned.some((base) => base.id === selectedOrgBase.id)}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{t('knowledge.org.select_base')}</p>
          )}
        </div>
      ) : selectedBase ? (
        <KnowledgePageDetailSection />
      ) : !isLoading ? (
        <KnowledgePageEmptyStateSection />
      ) : (
        <main
          data-ui="knowledge.content"
          className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          {t('common.loading')}
        </main>
      )}
    </KnowledgePageShell>
  )
}

interface KnowledgePageProps {
  baseId?: string
  onBaseIdChange: (baseId?: string) => void
}

const KnowledgePage = ({ baseId, onBaseIdChange }: KnowledgePageProps) => {
  return (
    <KnowledgePageProvider baseId={baseId} onBaseIdChange={onBaseIdChange}>
      <KnowledgePageContent />
      <KnowledgePageDialogSection />
    </KnowledgePageProvider>
  )
}

export default KnowledgePage
