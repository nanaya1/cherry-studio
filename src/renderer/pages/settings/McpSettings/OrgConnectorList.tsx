import { Badge, Button } from '@cherrystudio/ui'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { useOrgConnectors } from '@renderer/hooks/useOrgConnectors'
import { useMcpServers } from '@renderer/hooks/useMcpServer'
import { toast } from '@renderer/services/toast'
import { cn } from '@renderer/utils/style'
import { Check, Download, LoaderCircle, Plug } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

// [enterprise] T0 组织连接器目录：企业下发的直连型 SSE MCP，一键安装为本地 MCP 服务器
interface OrgConnectorListProps {
  variant?: 'settings' | 'catalog'
  toolbarStart?: ReactNode
}

const OrgConnectorList: FC<OrgConnectorListProps> = ({ variant = 'catalog', toolbarStart }) => {
  const { t } = useTranslation()
  const { connectors, loading, error, install, installing, refetch } = useOrgConnectors(variant === 'catalog')
  const { mcpServers } = useMcpServers()
  const [searchText, setSearchText] = useState('')

  const isCatalog = variant === 'catalog'

  const filteredConnectors = useMemo(() => {
    const keyword = searchText.trim().toLowerCase()
    if (!keyword) return connectors
    return connectors.filter(
      (c) => c.name.toLowerCase().includes(keyword) || c.description.toLowerCase().includes(keyword)
    )
  }, [connectors, searchText])

  // 轮询安装状态太重；这里以「同名 MCP 服务器已存在」视为已安装（与内置列表的判定一致）
  const isInstalled = (name: string) => mcpServers.some((s) => s.name === name)

  const handleInstall = async (slug: string) => {
    try {
      await install(slug)
      toast.success(t('settings.mcp.addSuccess'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.mcp.addError'))
    }
  }

  if (!isCatalog) return null

  return (
    <div className="mb-5">
      <div className="mb-3 flex w-full min-w-0 flex-wrap items-center justify-between gap-3">
        {toolbarStart}
        <div className="flex min-w-0 items-center gap-2">
          <CollapsibleSearchBar
            onSearch={setSearchText}
            placeholder={t('settings.mcp.search.placeholder')}
            tooltip={t('settings.mcp.search.tooltip')}
            maxWidth={240}
            style={{ borderRadius: 16 }}
          />
          <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => void refetch()}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {loading && connectors.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
      ) : error ? (
        <div className="py-10 text-center text-muted-foreground text-sm">{error}</div>
      ) : filteredConnectors.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">{t('library.org_skill.empty_title')}</div>
      ) : (
        <div className="grid @[1120px]/mcp-discover:grid-cols-4 @[560px]/mcp-discover:grid-cols-2 @[840px]/mcp-discover:grid-cols-3 grid-cols-1 gap-3">
          {filteredConnectors.map((connector) => {
            const installed = isInstalled(connector.name)
            return (
              <div
                key={connector.slug}
                className={cn(
                  'group relative flex min-h-28 min-w-0 flex-col rounded-lg border border-border-subtle bg-card p-3.5 transition-[background-color,border-color,box-shadow] hover:border-border-strong hover:bg-background-subtle hover:shadow-sm',
                  installed && 'bg-muted/25'
                )}>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2.5 pr-16">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Plug className="size-4 text-muted-foreground" />
                    </div>
                    <h3 className="min-w-0 truncate font-semibold text-base leading-5">{connector.name}</h3>
                    <Badge
                      variant="outline"
                      className="h-5 shrink-0 rounded-md border-primary/30 bg-primary/10 px-1.5 text-[11px] text-primary leading-none">
                      {t('workspace.skillsConnectors.sources.org')}
                    </Badge>
                  </div>
                  <p className="mt-3 line-clamp-2 text-muted-foreground text-sm leading-5">{connector.description}</p>
                  {/* stdio 连接器无 baseUrl：显示命令预览（与 MCP 详情页同款格式） */}
                  <p className="mt-1 truncate font-mono text-[11px] text-foreground-tertiary">
                    {connector.baseUrl || [connector.config.command as string, ...((connector.config.args as string[] | undefined) ?? [])].filter(Boolean).join(' ')}
                  </p>
                </div>
                <div className="absolute top-3.5 right-3 flex shrink-0 items-center justify-end gap-1">
                  {installed ? (
                    <div className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-muted-foreground text-xs">
                      <Check size={13} className="text-success" />
                      {t('settings.skills.installed')}
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={installing.has(connector.slug)}
                      className="size-7 rounded-md text-muted-foreground shadow-none hover:bg-muted hover:text-foreground hover:shadow-none"
                      onClick={() => void handleInstall(connector.slug)}>
                      {installing.has(connector.slug) ? (
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
      )}
    </div>
  )
}

export default OrgConnectorList
