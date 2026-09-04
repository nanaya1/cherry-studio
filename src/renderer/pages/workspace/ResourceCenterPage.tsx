import { Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { ResourceCatalogView } from '@renderer/components/resourceCatalog/catalog'
import { useTranslation } from 'react-i18next'

export default function ResourceCenterPage() {
  const { t } = useTranslation()

  return (
    <Tabs defaultValue="assistant" variant="underline" className="flex h-full min-h-0 flex-col">
      <header className="flex h-(--navbar-height) shrink-0 items-center border-border-subtle border-b px-5">
        <h1 className="shrink-0 font-medium text-sm">{t('workspace.resources.title')}</h1>
        <TabsList className="ml-7 h-full">
          <TabsTrigger value="assistant">{t('common.assistant_other')}</TabsTrigger>
          <TabsTrigger value="agent">{t('common.agent_other')}</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="assistant" className="min-h-0 flex-1">
        <ResourceCatalogView resourceType="assistant" />
      </TabsContent>
      <TabsContent value="agent" className="min-h-0 flex-1">
        <ResourceCatalogView resourceType="agent" />
      </TabsContent>
    </Tabs>
  )
}
