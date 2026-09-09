import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import {
  RecommendedSkillCatalogView,
  SkillCatalogDialogs,
  SkillCatalogHeaderActions,
  SkillCatalogView
} from '@renderer/components/resourceCatalog/catalog'
import { ResourceCatalogSearchInput } from '@renderer/components/resourceCatalog/ResourceCatalogSearchInput'
import { useResourceCatalogController } from '@renderer/hooks/resourceCatalog'
import { ArrowLeft, Blocks, Download, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface SkillsConnectorsPageProps {
  connectorView: ReactNode
}

type SkillView = 'recommended' | 'installed'

export default function SkillsConnectorsPage({ connectorView }: SkillsConnectorsPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('skill')
  const [skillView, setSkillView] = useState<SkillView>('recommended')
  const [recommendedSearch, setRecommendedSearch] = useState('')
  const skillController = useResourceCatalogController('skill', { clientSideSkillSearch: true })
  const installedCount = skillController.gridProps.allResources.filter((resource) => resource.type === 'skill').length

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col gap-0">
      <header className="mt-4 flex h-(--navbar-height) shrink-0 items-center justify-between gap-4 px-6">
        {skillView === 'installed' ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => setSkillView('recommended')}>
              <ArrowLeft className="size-4" />
              {t('workspace.skill_catalog.all_skills')}
            </Button>
          </div>
        ) : (
          <TabsList className="h-9 shrink-0 gap-1 bg-transparent p-0">
            <TabsTrigger
              value="skill"
              className="h-8 flex-none gap-2 border-0 px-2.5 py-1.5 text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-foreground dark:data-[state=active]:text-background">
              <Blocks className="size-3.5" />
              {t('settings.skills.title')}
            </TabsTrigger>
            <TabsTrigger
              value="connector"
              className="h-8 flex-none gap-2 border-0 px-2.5 py-1.5 text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-foreground dark:data-[state=active]:text-background">
              <Plug className="size-3.5" />
              {t('workspace.resources.connectors')}
            </TabsTrigger>
          </TabsList>
        )}

        {activeTab === 'skill' && skillView === 'recommended' && (
          <div className="flex min-w-0 items-center gap-2">
            <ResourceCatalogSearchInput
              value={recommendedSearch}
              onValueChange={setRecommendedSearch}
              placeholder={t('library.toolbar.search_placeholder')}
              className="w-64 max-w-[32vw] max-lg:w-40"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-2"
              onClick={() => setSkillView('installed')}>
              <Download className="size-3.5" />
              <span className="max-lg:sr-only">{t('workspace.skill_catalog.my_installed')}</span>
              <span className="text-muted-foreground text-xs">{installedCount}</span>
            </Button>
            <SkillCatalogHeaderActions controller={skillController} showSearch={false} />
          </div>
        )}
      </header>

      <TabsContent value="skill" className="min-h-0 flex-1">
        {skillView === 'recommended' ? (
          <RecommendedSkillCatalogView search={recommendedSearch} />
        ) : (
          <SkillCatalogView controller={skillController} secondary showDialogs={false} />
        )}
      </TabsContent>
      <TabsContent value="connector" className="min-h-0 flex-1">
        {connectorView}
      </TabsContent>
      <SkillCatalogDialogs controller={skillController} />
    </Tabs>
  )
}
