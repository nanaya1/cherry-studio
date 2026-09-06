import { Button, Scrollbar, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { useMcpServers } from '@renderer/hooks/useMcpServer'
import { cn } from '@renderer/utils/style'
import { ArrowLeft, FolderCog } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import BuiltinMcpServerList from './BuiltinMcpServerList'
import McpMarketList from './McpMarketList'
import McpProviderSettings from './McpProviderSettings'
import McpServersList from './McpServersList'
import { getMcpProviderLogo, getProviderDisplayName, type ProviderConfig, providers } from './providers/config'

type CatalogTab = 'discover' | 'providers' | 'mine'
type DiscoverTab = 'builtin' | 'marketplace'

const primaryTabClassName =
  'h-10 flex-none rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-1.5 font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-transparent'

export default function McpCatalog() {
  const { t } = useTranslation()
  const { mcpServers } = useMcpServers()
  const [activeTab, setActiveTab] = useState<CatalogTab>('discover')
  const [discoverTab, setDiscoverTab] = useState<DiscoverTab>('builtin')
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig | null>(null)

  const changeTab = (value: string) => {
    setActiveTab(value as CatalogTab)
    if (value !== 'providers') setSelectedProvider(null)
  }

  return (
    <Tabs value={activeTab} onValueChange={changeTab} className="flex h-full min-h-0 flex-col gap-0">
      <div className="shrink-0 px-6 pt-5">
        <TabsList className="h-11 gap-6 rounded-none bg-transparent p-0">
          <TabsTrigger value="discover" className={primaryTabClassName}>
            {t('settings.mcp.discover')}
          </TabsTrigger>
          <TabsTrigger value="providers" className={primaryTabClassName}>
            {t('settings.mcp.providers')}
          </TabsTrigger>
          <TabsTrigger value="mine" className={primaryTabClassName}>
            {t('settings.mcp.myServers')}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="discover" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pt-5 pb-4">
          <div role="tablist" aria-label={t('settings.mcp.discover')} className="flex gap-1">
            <Button
              role="tab"
              aria-selected={discoverTab === 'builtin'}
              variant={discoverTab === 'builtin' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 rounded-md px-3 font-normal"
              onClick={() => setDiscoverTab('builtin')}>
              {t('settings.mcp.builtinServers')}
            </Button>
            <Button
              role="tab"
              aria-selected={discoverTab === 'marketplace'}
              variant={discoverTab === 'marketplace' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 rounded-md px-3 font-normal"
              onClick={() => setDiscoverTab('marketplace')}>
              {t('settings.mcp.marketplaces')}
            </Button>
          </div>
        </div>
        <Scrollbar className="@container/mcp-discover min-h-0 flex-1 px-6 pb-6">
          {discoverTab === 'builtin' ? <BuiltinMcpServerList variant="catalog" /> : <McpMarketList variant="catalog" />}
        </Scrollbar>
      </TabsContent>

      <TabsContent value="providers" className="min-h-0 flex-1">
        {selectedProvider ? (
          <Scrollbar className="h-full px-6 py-5">
            <div className="mx-auto max-w-3xl">
              <Button
                variant="ghost"
                size="sm"
                className="mb-3 h-8 gap-1.5 px-2 text-muted-foreground"
                onClick={() => setSelectedProvider(null)}>
                <ArrowLeft className="size-3.5" />
                {t('common.back')}
              </Button>
              <McpProviderSettings provider={selectedProvider} existingServers={mcpServers} />
            </div>
          </Scrollbar>
        ) : (
          <Scrollbar className="@container/mcp-providers h-full px-6 py-5">
            <div className="grid @[1120px]/mcp-providers:grid-cols-4 @[560px]/mcp-providers:grid-cols-2 @[840px]/mcp-providers:grid-cols-3 grid-cols-1 gap-3">
              {providers.map((provider) => {
                const Logo = getMcpProviderLogo(provider.key)
                const providerName = getProviderDisplayName(provider, t)

                return (
                  <button
                    key={provider.key}
                    type="button"
                    className={cn(
                      'group flex min-h-24 items-center gap-3 rounded-lg border border-border-subtle bg-card p-3.5 text-left',
                      'transition-[border-color,box-shadow] hover:border-border hover:shadow-sm',
                      'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                    )}
                    onClick={() => setSelectedProvider(provider)}>
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {Logo ? <Logo.Avatar size={28} shape="circle" /> : <FolderCog className="size-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-sm leading-5">{providerName}</div>
                      <div className="mt-1 truncate text-muted-foreground text-xs">
                        {t('settings.provider.api_key.label')}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </Scrollbar>
        )}
      </TabsContent>

      <TabsContent value="mine" className="min-h-0 flex-1">
        <McpServersList variant="catalog" showTitle={false} />
      </TabsContent>
    </Tabs>
  )
}
