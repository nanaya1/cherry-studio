import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { SkillCatalogHeaderActions, SkillCatalogView } from '@renderer/components/resourceCatalog/catalog'
import { useResourceCatalogController } from '@renderer/hooks/resourceCatalog'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { Blocks, MessagesSquare, Network, Plug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function SkillsConnectorsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('skill')
  const skillController = useResourceCatalogController('skill', { clientSideSkillSearch: true })

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col gap-0">
      <header className="flex h-(--navbar-height) shrink-0 items-center justify-between gap-4 px-6">
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
        {activeTab === 'skill' ? <SkillCatalogHeaderActions controller={skillController} /> : null}
      </header>

      <TabsContent value="skill" className="min-h-0 flex-1">
        <SkillCatalogView controller={skillController} />
      </TabsContent>
      <TabsContent value="connector" className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-semibold text-2xl tracking-tight">{t('workspace.resources.connectors')}</h1>
          <p className="mt-2 text-muted-foreground">{t('workspace.resources.connectorsDescription')}</p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Button
              variant="outline"
              className="h-auto justify-start rounded-xl p-5 text-left"
              onClick={() => openSettingsTab('/settings/mcp/servers')}>
              <Network className="mr-3 size-5 shrink-0" />
              <span>
                <span className="block font-medium">{t('title.mcp-servers')}</span>
                <span className="mt-1 block whitespace-normal font-normal text-muted-foreground text-sm">
                  {t('workspace.resources.mcpDescription')}
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              className="h-auto justify-start rounded-xl p-5 text-left"
              onClick={() => openSettingsTab('/settings/channels')}>
              <MessagesSquare className="mr-3 size-5 shrink-0" />
              <span>
                <span className="block font-medium">{t('settings.channels.title')}</span>
                <span className="mt-1 block whitespace-normal font-normal text-muted-foreground text-sm">
                  {t('workspace.resources.channelsDescription')}
                </span>
              </span>
            </Button>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}
