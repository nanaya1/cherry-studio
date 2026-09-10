import { Button, Popover, PopoverContent, PopoverTrigger, Tabs, TabsList, TabsTrigger } from '@cherrystudio/ui'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { SettingTitle } from '@renderer/components/SettingsPrimitives'
import { useMcpServers } from '@renderer/hooks/useMcpServer'
import { getBuiltInMcpServerDescriptionLabelKey } from '@renderer/i18n/label'
import { toast } from '@renderer/services/toast'
import { cn } from '@renderer/utils/style'
import { PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'
import { BuiltinMcpServerNames } from '@shared/utils/mcp'
import { Check, Download, LoaderCircle, Plug } from 'lucide-react'
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
  const [installingServer, setInstallingServer] = useState<string | null>(null)

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
                'group relative min-w-0 rounded-lg border border-border-subtle bg-card transition-[background-color,border-color,box-shadow] hover:border-border-strong hover:bg-background-subtle hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                isCatalog ? 'flex min-h-28 flex-col p-3.5' : 'flex min-h-16 items-center gap-3 px-3.5 py-2',
                isInstalled && 'bg-muted/25'
              )}>
              <div className="min-w-0 flex-1">
                <div className={cn('flex min-w-0 items-center gap-2.5', isCatalog && 'pr-16')}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Plug className="size-4 text-muted-foreground" />
                  </div>
                  <h3 className="min-w-0 truncate font-semibold text-base leading-5">{server.name}</h3>
                  {/* 「需配置」徽章暂时隐藏：target="_blank" 跳转到 docs.cherry-ai.com，属 Cherry 厂商云。恢复时把 null 换成下面的 <a>。 */}
                  {null}
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <div
                      className={cn(
                        'line-clamp-2 cursor-pointer text-muted-foreground text-sm leading-5 transition-colors hover:text-foreground',
                        isCatalog ? 'mt-3' : 'mt-1'
                      )}>
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
                  'flex shrink-0 items-center justify-end gap-1',
                  isCatalog ? 'absolute top-3.5 right-3' : 'ml-3 min-w-21.5 self-center'
                )}>
                {isInstalled ? (
                  <div
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2 text-muted-foreground text-xs',
                      isCatalog ? 'h-7' : 'h-7 min-w-21.5 justify-center'
                    )}>
                    <Check size={13} className="text-success" />
                    {t('settings.skills.installed')}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={installingServer === server.name}
                    aria-label={
                      installingServer === server.name ? t('settings.skills.installed') : t('settings.skills.install')
                    }
                    className="size-7 rounded-md text-muted-foreground shadow-none hover:bg-muted hover:text-foreground hover:shadow-none"
                    onClick={async () => {
                      if (installingServer) return
                      setInstallingServer(server.name)
                      try {
                        await addMcpServer(toCreateMcpServerDto(server))
                        toast.success(t('settings.mcp.addSuccess'))
                      } catch {
                        toast.error(t('settings.mcp.addError'))
                      } finally {
                        setInstallingServer(null)
                      }
                    }}>
                    {installingServer === server.name ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
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
