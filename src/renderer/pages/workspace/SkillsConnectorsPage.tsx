import { ArrowLeft, Blocks, Download, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import {
  OrgSkillCatalogView,
  RecommendedSkillCatalogView,
  SkillCatalogDialogs,
  SkillCatalogHeaderActions,
  SkillCatalogView
} from '@renderer/components/resourceCatalog/catalog'
import { ResourceCatalogSearchInput } from '@renderer/components/resourceCatalog/ResourceCatalogSearchInput'
import { useResourceCatalogController } from '@renderer/hooks/resourceCatalog'

interface SkillsConnectorsPageProps {
  connectorView: ReactNode
}

// [enterprise] skillView 曾增加 'org'，现组织技能由 OrgSubTab 管理
// type SkillView = 'recommended' | 'installed' | 'org'
type SkillView = 'recommended' | 'installed'
// [enterprise] 二级 tab：推荐（原技能市场内容）/ 组织（企业下发技能）
type OrgSubTab = 'recommended' | 'org'

// [enterprise] 与连接器目录二级 tab 保持一致
const secondaryTabClassName =
  'h-10 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-1.5 font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-transparent'

export default function SkillsConnectorsPage({ connectorView }: SkillsConnectorsPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('skill')
  const [skillView, setSkillView] = useState<SkillView>('recommended')
  const [recommendedSearch, setRecommendedSearch] = useState('')
  // [enterprise] 「推荐」一级视图内的二级 tab 状态
  const [orgSubTab, setOrgSubTab] = useState<OrgSubTab>('recommended')
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

      {/* MEA: 加 flex 容器属性 — TabsContent（radix）本身非 flex 容器，内层 SkillCatalogView 根节点的
          flex-1 会失效导致高度=内容高度、内层 Scrollbar 无法收缩触发滚动。原样式保留在上行注释。 */}
      {/* <TabsContent value="skill" className="min-h-0 flex-1"> */}
      <TabsContent value="skill" className="flex min-h-0 flex-1 flex-col">
        {skillView === 'recommended' ? (
          // [enterprise] 推荐一级视图内分「推荐 / 组织」二级 tab；组织页为卡片式目录
          <Tabs
            value={orgSubTab}
            onValueChange={(value) => setOrgSubTab(value as OrgSubTab)}
            className="flex min-h-0 flex-1 flex-col">
            {/* [enterprise] 原筛选 chip 风格保留，现统一为连接器目录的下划线二级 tab */}
            {/* <TabsList className="mx-6 h-auto shrink-0 justify-start gap-1 bg-transparent p-0"> */}
            <TabsList className="mx-6 h-11 shrink-0 justify-start gap-6 rounded-none bg-transparent p-0">
              {/* <TabsTrigger
                value="recommended"
                className="h-7 gap-1.5 rounded-full border-0 px-3 py-0 text-muted-foreground shadow-none hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:text-foreground">
                {t('workspace.skill_catalog.recommended')}
              </TabsTrigger> */}
              <TabsTrigger value="recommended" className={secondaryTabClassName}>
                {t('workspace.skill_catalog.recommended')}
              </TabsTrigger>
              {/* <TabsTrigger
                value="org"
                className="h-7 gap-1.5 rounded-full border-0 px-3 py-0 text-muted-foreground shadow-none hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:text-foreground">
                {t('workspace.skill_catalog.org')}
              </TabsTrigger> */}
              <TabsTrigger value="org" className={secondaryTabClassName}>
                {t('workspace.skill_catalog.org')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="recommended" className="flex min-h-0 flex-1 flex-col">
              <RecommendedSkillCatalogView
                search={recommendedSearch}
                onViewInstalled={() => setSkillView('installed')}
              />
            </TabsContent>
            <TabsContent value="org" className="flex min-h-0 flex-1 flex-col">
              {/* <OrgSkillCatalogView /> */}
              <OrgSkillCatalogView search={recommendedSearch} />
            </TabsContent>
          </Tabs>
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
