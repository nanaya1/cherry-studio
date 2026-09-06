import { Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { SkillCatalogView } from '@renderer/components/resourceCatalog/catalog'
import { useResourceCatalogController } from '@renderer/hooks/resourceCatalog'
import { Blocks, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface SkillsConnectorsPageProps {
  connectorView: ReactNode
}

export default function SkillsConnectorsPage({ connectorView }: SkillsConnectorsPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('skill')
  const skillController = useResourceCatalogController('skill', { clientSideSkillSearch: true })

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col gap-0">
      <header className="flex h-(--navbar-height) shrink-0 items-center px-6">
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
      </header>

      <TabsContent value="skill" className="min-h-0 flex-1">
        <SkillCatalogView controller={skillController} />
      </TabsContent>
      <TabsContent value="connector" className="min-h-0 flex-1">
        {connectorView}
      </TabsContent>
    </Tabs>
  )
}
