import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { ResourceCatalogView } from '@renderer/components/resourceCatalog/catalog'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { MessagesSquare, Network } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function SkillsConnectorsPage() {
  const { t } = useTranslation()

  return (
    <Tabs defaultValue="skill" variant="underline" className="flex h-full min-h-0 flex-col">
      <header className="flex h-(--navbar-height) shrink-0 items-center border-border-subtle border-b px-5">
        <h1 className="shrink-0 font-medium text-sm">{t('workspace.skillsConnectors.title')}</h1>
        <TabsList className="ml-7 h-full">
          <TabsTrigger value="skill">{t('settings.skills.title')}</TabsTrigger>
          <TabsTrigger value="connector">{t('workspace.resources.connectors')}</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="skill" className="min-h-0 flex-1">
        <ResourceCatalogView resourceType="skill" />
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
