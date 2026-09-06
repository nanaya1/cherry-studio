import {
  Composio,
  Glama,
  Higress,
  Mcp,
  Mcpso,
  Modelscope,
  Pulse,
  Smithery,
  Zhipu
} from '@cherrystudio/ui/icons/providers'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { SettingTitle } from '@renderer/components/SettingsPrimitives'
import { cn } from '@renderer/utils/style'
import { ExternalLink } from 'lucide-react'
import type React from 'react'
import type { FC, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const mcpMarkets = [
  {
    name: 'MCP World',
    url: 'https://www.mcpworld.com',
    logo: 'https://mcpworld.bdstatic.com/store/v2/865ad5d/mcp-server-store/ec04344/favicon.ico',
    descriptionKey: 'settings.mcp.more.mcpworld'
  },
  {
    name: 'BigModel MCP Market',
    url: 'https://bigmodel.cn/marketplace/index/mcp',
    logo: Zhipu,
    descriptionKey: 'settings.mcp.more.zhipu'
  },
  {
    name: 'modelscope.cn',
    url: 'https://www.modelscope.cn/mcp',
    logo: Modelscope,
    descriptionKey: 'settings.mcp.more.modelscope'
  },
  {
    name: 'mcp.higress.ai',
    url: 'https://mcp.higress.ai/',
    logo: Higress,
    descriptionKey: 'settings.mcp.more.higress'
  },
  {
    name: 'mcp.so',
    url: 'https://mcp.so/',
    logo: Mcpso,
    descriptionKey: 'settings.mcp.more.mcpso'
  },
  {
    name: 'smithery.ai',
    url: 'https://smithery.ai/',
    logo: Smithery,
    descriptionKey: 'settings.mcp.more.smithery'
  },
  {
    name: 'glama.ai',
    url: 'https://glama.ai/mcp/servers',
    logo: Glama,
    descriptionKey: 'settings.mcp.more.glama'
  },
  {
    name: 'pulsemcp.com',
    url: 'https://www.pulsemcp.com',
    logo: Pulse,
    descriptionKey: 'settings.mcp.more.pulsemcp'
  },
  {
    name: 'mcp.composio.dev',
    url: 'https://mcp.composio.dev/',
    logo: Composio,
    descriptionKey: 'settings.mcp.more.composio'
  },
  {
    name: 'Model Context Protocol Servers',
    url: 'https://github.com/modelcontextprotocol/servers',
    logo: Mcp,
    descriptionKey: 'settings.mcp.more.official'
  },
  {
    name: 'Awesome MCP Servers',
    url: 'https://github.com/wong2/awesome-mcp-servers',
    logo: 'https://github.githubassets.com/assets/github-logo-55c5b9a1fe52.png',
    descriptionKey: 'settings.mcp.more.awesome'
  }
]

interface McpMarketListProps {
  variant?: 'settings' | 'catalog'
  toolbarStart?: ReactNode
}

const McpMarketList: FC<McpMarketListProps> = ({ variant = 'settings', toolbarStart }) => {
  const { t } = useTranslation()
  const isCatalog = variant === 'catalog'
  const [searchText, setSearchText] = useState('')
  const filteredMarkets = useMemo(() => {
    const keyword = searchText.trim().toLowerCase()
    if (!keyword) return mcpMarkets

    return mcpMarkets.filter((market) => {
      const description = t(market.descriptionKey).toLowerCase()
      return market.name.toLowerCase().includes(keyword) || description.includes(keyword)
    })
  }, [searchText, t])

  return (
    <>
      {isCatalog ? (
        <div className="mb-3 flex w-full min-w-0 flex-wrap items-center justify-between gap-3">
          {toolbarStart}
          <CollapsibleSearchBar
            onSearch={setSearchText}
            placeholder={t('settings.mcp.search.placeholder')}
            tooltip={t('settings.mcp.search.tooltip')}
            maxWidth={240}
            style={{ borderRadius: 16 }}
          />
        </div>
      ) : (
        <SettingTitle style={{ marginBottom: 10 }}>{t('settings.mcp.findMore')}</SettingTitle>
      )}
      <MarketGrid data-variant={variant}>
        {filteredMarkets.map((resource) => (
          <MarketCard
            key={resource.name}
            type="button"
            data-variant={variant}
            onClick={() => window.open(resource.url, '_blank', 'noopener,noreferrer')}>
            <MarketIconWrap>
              {typeof resource.logo !== 'string' ? (
                <resource.logo.Avatar size={22} shape="rounded" />
              ) : (
                <MarketLogo src={resource.logo} alt={`${resource.name} logo`} />
              )}
            </MarketIconWrap>
            <MarketContent>
              <MarketHeader>
                <MarketName>{resource.name}</MarketName>
                <ExternalLinkIcon>
                  <ExternalLink size={13} />
                </ExternalLinkIcon>
              </MarketHeader>
              <MarketDescription>{t(resource.descriptionKey)}</MarketDescription>
            </MarketContent>
          </MarketCard>
        ))}
      </MarketGrid>
    </>
  )
}

const MarketGrid = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div
    className={cn(
      'mb-5 gap-3 data-[variant=settings]:flex data-[variant=catalog]:grid @[1120px]/mcp-discover:data-[variant=catalog]:grid-cols-4 @[560px]/mcp-discover:data-[variant=catalog]:grid-cols-2 @[840px]/mcp-discover:data-[variant=catalog]:grid-cols-3 data-[variant=catalog]:grid-cols-1 data-[variant=settings]:flex-col',
      className
    )}
    {...props}
  />
)

const MarketCard = ({ className, ...props }: React.ComponentPropsWithoutRef<'button'>) => (
  <button
    type="button"
    className={cn(
      'flex min-h-15 w-full cursor-pointer items-center gap-3 rounded-lg border border-border-subtle bg-card px-3 py-2.5 text-left transition-[border-color,box-shadow] hover:border-border hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[variant=catalog]:min-h-20',
      className
    )}
    {...props}
  />
)

const MarketIconWrap = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted', className)} {...props} />
)

const MarketContent = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div className={cn('min-w-0 flex-1', className)} {...props} />
)

const MarketHeader = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div className={cn('flex items-center gap-2', className)} {...props} />
)

const MarketLogo = ({ className, ...props }: React.ComponentPropsWithoutRef<'img'>) => (
  <img className={cn('size-5.5 rounded object-cover', className)} {...props} />
)

const MarketName = ({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) => (
  <span className={cn('flex-1 truncate text-sm', className)} {...props} />
)

const ExternalLinkIcon = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div className={cn('flex shrink-0 items-center text-foreground-tertiary', className)} {...props} />
)

const MarketDescription = ({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
  <div
    className={cn('mt-0.5 line-clamp-1 overflow-hidden text-[13px] text-muted-foreground leading-[1.35]', className)}
    {...props}
  />
)

export default McpMarketList
