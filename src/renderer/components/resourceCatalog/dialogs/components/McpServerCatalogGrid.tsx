import type { TFunction } from 'i18next'
import { Settings } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Tooltip } from '@cherrystudio/ui'
import { useQuery } from '@renderer/data/hooks/useDataApi'
import { useMcpRuntimeStatusMap } from '@renderer/hooks/useMcpRuntimeStatus'
// MEA:mcp-jump 原导入保留注释，恢复时取消注释：import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { openRoute } from '@renderer/services/mainWindowNavigation'
import type { McpRuntimeStatus } from '@shared/data/cache/cacheValueTypes'
import type { McpServer } from '@shared/data/types/mcpServer'
import { isBrowserMcpServer } from '@shared/utils/mcp'

import { type CatalogItem, CatalogToggleGrid } from './CatalogPicker'

// MEA:mcp-jump 设置侧栏已隐藏 /settings/mcp，齿轮改跳工作台「技能与连接器」页的连接器 tab
// const MCP_SERVERS_SETTINGS_PATH = '/settings/mcp/servers'
const MCP_CATALOG_PATH = '/app/skills-connectors?tab=connector'

function getStatusBadge(t: TFunction, state: McpRuntimeStatus['state']) {
  switch (state) {
    case 'connected':
      return t('settings.mcp.runtimeStatus.connected', 'Connected')
    case 'connecting':
      return t('settings.mcp.runtimeStatus.connecting', 'Connecting')
    case 'error':
      return t('settings.mcp.runtimeStatus.unavailable', 'Unavailable')
    default:
      return undefined
  }
}

function getStatusBadgeClassName(state: McpRuntimeStatus['state']) {
  switch (state) {
    case 'connected':
      return 'border-success-border bg-success-subtle text-success-subtle-foreground'
    case 'connecting':
      return 'border-warning-border bg-warning-subtle text-warning-subtle-foreground'
    case 'error':
      return 'border-error-border bg-error-subtle text-error-subtle-foreground'
    default:
      return undefined
  }
}

function getServerState(server: McpServer, status: McpRuntimeStatus | undefined): McpRuntimeStatus['state'] {
  return server.isActive ? (status?.state ?? 'connecting') : 'disabled'
}

export function McpServerCatalogGrid({
  enabledIds,
  emptyLabel,
  onOpenSettings,
  onToggle,
  portalContainer,
  title
}: {
  enabledIds: ReadonlySet<string>
  emptyLabel: string
  onOpenSettings?: () => void
  onToggle: (id: string, enabled: boolean) => void
  portalContainer: HTMLElement | null
  title?: string
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery('/mcp-servers', {})
  const mcpServers = useMemo<McpServer[]>(
    () => data?.items.filter((server) => !isBrowserMcpServer(server)) ?? [],
    [data]
  )
  const mcpStatuses = useMcpRuntimeStatusMap(mcpServers)
  const settingsLabel = title ? `${title} ${t('settings.title')}` : t('settings.mcp.title')
  const catalog = useMemo<CatalogItem[]>(
    () =>
      mcpServers.map((server) => {
        const state = getServerState(server, mcpStatuses[server.id])

        return {
          id: server.id,
          name: server.name,
          inactiveBadge: server.isActive ? undefined : t('library.config.tools.inactive_badge'),
          statusBadge: getStatusBadge(t, state),
          statusBadgeClassName: getStatusBadgeClassName(state),
          pickable: server.isActive
        }
      }),
    [mcpServers, mcpStatuses, t]
  )

  const handleOpenMcpSettings = () => {
    // MEA:mcp-jump 编辑弹窗场景由宿主接管（先关弹窗再跳转）；无宿主时直接跳技能连接器页。
    if (onOpenSettings) {
      onOpenSettings()
      return
    }
    openRoute(MCP_CATALOG_PATH)
  }

  return (
    <div>
      {title ? (
        <div className="flex items-center gap-1.5">
          <div className="text-[13px] leading-none font-medium text-foreground">{title}</div>
          <Tooltip content={settingsLabel} portalContainer={portalContainer ?? undefined}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={settingsLabel}
              title={settingsLabel}
              onClick={handleOpenMcpSettings}
              className="flex size-6 min-h-0 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground shadow-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground">
              <Settings size={12} strokeWidth={1.7} />
            </Button>
          </Tooltip>
        </div>
      ) : null}
      <div className={title ? 'mt-2' : undefined}>
        <CatalogToggleGrid
          items={catalog}
          enabledIds={enabledIds}
          loading={isLoading}
          onToggle={onToggle}
          emptyLabel={emptyLabel}
          portalContainer={portalContainer}
          layout="list"
        />
      </div>
    </div>
  )
}
