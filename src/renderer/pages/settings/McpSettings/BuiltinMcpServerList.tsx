import { Button, Popover, PopoverContent, PopoverTrigger, Tabs, TabsList, TabsTrigger } from '@cherrystudio/ui'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { SettingTitle } from '@renderer/components/SettingsPrimitives'
import { useMcpServers } from '@renderer/hooks/useMcpServer'
import { getBuiltInMcpServerDescriptionLabelKey } from '@renderer/i18n/label'
import { toast } from '@renderer/services/toast'
import { cn } from '@renderer/utils/style'
import { PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'
import { BuiltinMcpServerNames } from '@shared/utils/mcp'
import { Check, Plus } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { QVERIS_API_KEY_REGISTRATION_URL } from './QVerisApiKeyGuide'
import { toCreateMcpServerDto } from './utils'

interface BuiltinMcpServerListProps {
  variant?: 'settings' | 'catalog'
  toolbarStart?: ReactNode
}

const BuiltinMcpServerList: FC<BuiltinMcpServerListProps> = ({ variant = 'settings', toolbarStart }) => {
  const { t } = useTranslation()
  const { addMcpServer, mcpServers } = useMcpServers()
  const [searchText, setSearchText] = useState('')
  const [filter, setFilter] = useState<'installed' | 'uninstalled'>('uninstalled')

  const filteredServers = useMemo(() => {
    const keyword = searchText.trim().toLowerCase()

    return PRESET_MCP_SERVERS.filter((server) => {
      const isInstalled = mcpServers.some((existingServer) => existingServer.name === server.name)

      if (filter === 'installed' && !isInstalled) return false
      if (filter === 'uninstalled' && isInstalled) return false

      if (!keyword) return true

      const description = t(getBuiltInMcpServerDescriptionLabelKey(server.name)).toLowerCase()
      return server.name.toLowerCase().includes(keyword) || description.includes(keyword)
    }).sort((a, b) => Number(Boolean(a.shouldConfig)) - Number(Boolean(b.shouldConfig)))
  }, [filter, mcpServers, searchText, t])

  const isCatalog = variant === 'catalog'

  return (
    <div className="mb-5">
      <div className="mb-3 flex w-full min-w-0 flex-wrap items-center justify-between gap-3">
        {isCatalog ? (
          <>
            {toolbarStart}
            <div className="flex min-w-0 items-center gap-2">
              <CollapsibleSearchBar
                onSearch={setSearchText}
                placeholder={t('settings.mcp.search.placeholder')}
                tooltip={t('settings.mcp.search.tooltip')}
                maxWidth={240}
                style={{ borderRadius: 16 }}
              />
              <ServerFilter value={filter} onValueChange={setFilter} />
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <SettingTitle className="m-0">{t('settings.mcp.builtinServers')}</SettingTitle>
              <CollapsibleSearchBar
                onSearch={setSearchText}
                placeholder={t('settings.mcp.search.placeholder')}
                tooltip={t('settings.mcp.search.tooltip')}
                maxWidth={200}
                style={{ borderRadius: 16 }}
              />
            </div>
            <ServerFilter value={filter} onValueChange={setFilter} />
          </>
        )}
      </div>

      <div
        className={cn(
          isCatalog
            ? 'grid @[1120px]/mcp-discover:grid-cols-4 @[560px]/mcp-discover:grid-cols-2 @[840px]/mcp-discover:grid-cols-3 grid-cols-1 gap-3'
            : 'flex flex-col gap-2'
        )}>
        {filteredServers.map((server) => {
          const isInstalled = mcpServers.some((existingServer) => existingServer.name === server.name)

          return (
            <div
              key={server.name}
              className={cn(
                'group flex items-center gap-3 rounded-lg border border-border-subtle px-3.5 transition-colors duration-200 ease-in-out hover:border-border hover:bg-muted/35',
                isCatalog ? 'min-h-24 py-3' : 'min-h-16 py-2',
                isInstalled && 'bg-muted/25'
              )}>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden">
                  <span className="truncate text-[14px] leading-5">{server.name}</span>
                  {/* 「需配置」徽章暂时隐藏：target="_blank" 跳转到 docs.cherry-ai.com，属 Cherry 厂商云。恢复时把 null 换成下面的 <a>。 */}
                  {null}
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <div className="line-clamp-2 cursor-pointer text-[13px] text-muted-foreground leading-5 transition-colors hover:text-foreground">
                      {t(getBuiltInMcpServerDescriptionLabelKey(server.name))}
                    </div>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="top" className="w-auto max-w-100">
                    <div className="mb-2 font-semibold text-foreground text-sm">{server.name}</div>
                    <div className="wrap-break-word whitespace-pre-wrap text-[14px] text-foreground leading-normal">
                      {t(getBuiltInMcpServerDescriptionLabelKey(server.name))}
                      {server.reference && (
                        <a
                          href={server.reference}
                          className="wrap-break-word mt-2 inline-block text-link hover:underline">
                          {server.reference}
                        </a>
                      )}
                      {server.name === BuiltinMcpServerNames.qveris && (
                        <a
                          href={QVERIS_API_KEY_REGISTRATION_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="wrap-break-word mt-2 block text-link hover:underline">
                          {t('settings.mcp.qveris.get_api_key')}
                        </a>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <div
                className={cn(
                  'flex shrink-0 items-center justify-end self-center',
                  isCatalog ? 'ml-1' : 'ml-3 min-w-21.5'
                )}>
                {isInstalled ? (
                  <div className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-muted-foreground text-xs">
                    <Check size={13} className="text-success" />
                    {t('settings.skills.installed')}
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-lg px-2 text-muted-foreground text-xs shadow-none hover:bg-muted hover:text-foreground hover:shadow-none"
                    onClick={async () => {
                      try {
                        await addMcpServer(toCreateMcpServerDto(server))
                        toast.success(t('settings.mcp.addSuccess'))
                      } catch {
                        toast.error(t('settings.mcp.addError'))
                      }
                    }}>
                    <Plus size={13} />
                    {t('settings.skills.install')}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ServerFilter({
  value,
  onValueChange
}: {
  value: 'installed' | 'uninstalled'
  onValueChange: (value: 'installed' | 'uninstalled') => void
}) {
  const { t } = useTranslation()

  return (
    <Tabs value={value} onValueChange={(nextValue) => onValueChange(nextValue as typeof value)} className="shrink-0">
      <TabsList className="h-8 rounded-full bg-muted/70 p-0.5">
        <TabsTrigger value="installed" className="h-7 rounded-[14px] px-2.5 text-xs">
          {t('settings.skills.installed')}
        </TabsTrigger>
        <TabsTrigger value="uninstalled" className="h-7 rounded-[14px] px-2.5 text-xs">
          {t('settings.mcp.notInstalled')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export default BuiltinMcpServerList
