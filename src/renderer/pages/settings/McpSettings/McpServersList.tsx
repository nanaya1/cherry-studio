import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  EmptyState,
  MenuItem,
  MenuList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Scrollbar,
  Sortable,
  useDndReorder
} from '@cherrystudio/ui'
import { loggerService } from '@logger'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { SettingTitle } from '@renderer/components/SettingsPrimitives'
import { useMcpServers } from '@renderer/hooks/useMcpServer'
import { ipcApi } from '@renderer/ipc'
import EnvironmentDependencies from '@renderer/pages/settings/DependenciesSettings/EnvironmentDependencies'
import { toast } from '@renderer/services/toast'
import { matchKeywordsInString } from '@renderer/utils/match'
import { cn } from '@renderer/utils/style'
import type { CreateMcpServerDto } from '@shared/data/api/schemas/mcpServers'
import type { ProtocolMcpInstallRequest } from '@shared/data/types/mcpProtocolInstall'
import type { McpServer } from '@shared/data/types/mcpServer'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Check, ChevronDown, Filter, Plus } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import AddMcpServerModal from './AddMcpServerModal'
import McpProtocolInstallDialog from './McpProtocolInstallDialog'
import McpServerCard from './McpServerCard'
import McpSettings from './McpSettings'
import QuickCreateMcpServerDialog from './QuickCreateMcpServerDialog'

const logger = loggerService.withContext('McpServersList')

type ImportMethod = 'json' | 'dxt' | 'mcpb'
type McpServerFilter = 'all' | 'enabled' | 'disabled' | 'stdio' | 'sse' | 'streamableHttp' | 'builtin'
const FILTER_OPTIONS: { value: McpServerFilter; labelKey?: string; label?: string }[] = [
  { value: 'all', labelKey: 'models.all' },
  { value: 'enabled', labelKey: 'common.enabled' },
  { value: 'disabled', labelKey: 'common.disabled' },
  { value: 'stdio', label: 'STDIO' },
  { value: 'sse', label: 'SSE' },
  { value: 'streamableHttp', labelKey: 'settings.mcp.types.streamableHttp' },
  { value: 'builtin', labelKey: 'settings.mcp.builtinServers' }
]

interface McpServersListProps {
  variant?: 'settings' | 'catalog'
  showTitle?: boolean
}

const McpServersList: FC<McpServersListProps> = ({ variant = 'settings', showTitle = true }) => {
  const { mcpServers, addMcpServer, reorderMcpServers, refetch } = useMcpServers()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as {
    protocolInstallRequestId?: string
  }
  const [isAddModalVisible, setIsAddModalVisible] = useState(false)
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false)
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false)
  const [isQuickCreateOpen, setIsQuickCreateOpen] = useState(false)
  const [modalType, setModalType] = useState<ImportMethod>('json')
  const [filter, setFilter] = useState<McpServerFilter>('all')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [protocolInstallQueue, setProtocolInstallQueue] = useState<ProtocolMcpInstallRequest[]>([])
  const protocolInstallQueueRef = useRef<ProtocolMcpInstallRequest[]>([])
  const pendingAutoEnableServerIdRef = useRef<string | null>(null)
  const protocolInstallRequest = protocolInstallQueue[0]

  const [searchText, setSearchText] = useState('')
  // Keep typing responsive: the list re-filters on the deferred value.
  const deferredSearchText = useDeferredValue(searchText)

  const updateProtocolInstallQueue = useCallback(
    (update: (queue: ProtocolMcpInstallRequest[]) => ProtocolMcpInstallRequest[]) => {
      const nextQueue = update(protocolInstallQueueRef.current)
      protocolInstallQueueRef.current = nextQueue
      setProtocolInstallQueue(nextQueue)
      return nextQueue
    },
    []
  )

  useEffect(() => {
    void ipcApi.request('mcp.protocol_install.list_pending').then(
      (requests) => updateProtocolInstallQueue(() => requests),
      (error) => logger.error('Failed to list MCP protocol install requests', error as Error)
    )
  }, [search.protocolInstallRequestId, updateProtocolInstallQueue])

  const removeProtocolInstallRequest = useCallback(
    (requestId: string) => {
      return updateProtocolInstallQueue((queue) => queue.filter((request) => request.requestId !== requestId))
    },
    [updateProtocolInstallQueue]
  )

  const openProtocolServer = useCallback(
    (serverId: string) => {
      void navigate({
        to: '/settings/mcp/settings/$serverId',
        params: { serverId },
        search: { autoEnable: 'true' }
      })
    },
    [navigate]
  )

  const handleProtocolInstallClose = useCallback(async () => {
    if (!protocolInstallRequest) return

    try {
      await ipcApi.request('mcp.protocol_install.cancel', { requestId: protocolInstallRequest.requestId })
    } catch (error) {
      logger.error('Failed to cancel MCP protocol install request', error as Error)
      return
    }

    const remainingRequests = removeProtocolInstallRequest(protocolInstallRequest.requestId)
    if (remainingRequests.length > 0 || !pendingAutoEnableServerIdRef.current) return

    const serverId = pendingAutoEnableServerIdRef.current
    pendingAutoEnableServerIdRef.current = null
    openProtocolServer(serverId)
  }, [openProtocolServer, protocolInstallRequest, removeProtocolInstallRequest])

  const filteredMcpServers = useMemo(() => {
    const keywords = deferredSearchText.toLowerCase().split(/\s+/).filter(Boolean)

    return mcpServers.filter((server) => {
      if (filter === 'enabled' && !server.isActive) return false
      if (filter === 'disabled' && server.isActive) return false
      if (filter === 'stdio' && server.type !== 'stdio') return false
      if (filter === 'sse' && server.type !== 'sse') return false
      if (filter === 'streamableHttp' && server.type !== 'streamableHttp') return false
      if (filter === 'builtin' && server.installSource !== 'builtin') return false

      if (keywords.length === 0) return true

      const searchTarget = `${server.name} ${server.description} ${server.tags?.join(' ')} ${server.provider ?? ''}`
      return matchKeywordsInString(keywords, searchTarget)
    })
  }, [deferredSearchText, filter, mcpServers])

  const { onSortEnd } = useDndReorder({
    originalList: mcpServers,
    filteredList: filteredMcpServers,
    onUpdate: reorderMcpServers,
    itemKey: 'id'
  })

  const scrollRef = useRef<HTMLDivElement>(null)

  // 简单的滚动位置记忆
  useEffect(() => {
    // 恢复滚动位置
    const savedScroll = sessionStorage.getItem('mcp-list-scroll')
    if (savedScroll && scrollRef.current) {
      scrollRef.current.scrollTop = Number(savedScroll)
    }

    // 保存滚动位置
    const handleScroll = () => {
      if (scrollRef.current) {
        sessionStorage.setItem('mcp-list-scroll', String(scrollRef.current.scrollTop))
      }
    }

    const container = scrollRef.current
    container?.addEventListener('scroll', handleScroll)
    return () => container?.removeEventListener('scroll', handleScroll)
  }, [])

  const handleQuickCreate = useCallback(
    async (dto: CreateMcpServerDto) => {
      const newServer = await addMcpServer(dto)
      void navigate({ to: `/settings/mcp/settings/${newServer.id}` })
      toast.success(t('settings.mcp.addSuccess'))
    },
    [addMcpServer, navigate, t]
  )

  const handleAddServerSuccess = useCallback(
    async (dtos: CreateMcpServerDto[]): Promise<McpServer[]> => {
      const created: McpServer[] = []
      for (const dto of dtos) {
        created.push(await addMcpServer(dto))
      }
      setIsAddModalVisible(false)
      toast.success(t('settings.mcp.addSuccess'))
      return created
    },
    [addMcpServer, t]
  )

  const handleProtocolInstall = useCallback(async () => {
    if (!protocolInstallRequest) return

    let createdServers: McpServer[]
    try {
      createdServers = await ipcApi.request('mcp.protocol_install.install', {
        requestId: protocolInstallRequest.requestId
      })
    } catch (error) {
      logger.error('Failed to install MCP servers from protocol', error as Error)
      toast.error(t('settings.mcp.addError'))
      return
    }

    const lastCreatedServer = createdServers.at(-1)
    if (!lastCreatedServer) return

    void refetch().catch((error) =>
      logger.error('Failed to refresh MCP servers after protocol install', error as Error)
    )
    const remainingRequests = removeProtocolInstallRequest(protocolInstallRequest.requestId)
    toast.success(t('settings.mcp.addSuccess'))
    if (remainingRequests.length > 0) {
      pendingAutoEnableServerIdRef.current = lastCreatedServer.id
      return
    }

    pendingAutoEnableServerIdRef.current = null
    openProtocolServer(lastCreatedServer.id)
  }, [openProtocolServer, protocolInstallRequest, refetch, removeProtocolInstallRequest, t])

  const handleManualAdd = useCallback(() => {
    setIsAddMenuOpen(false)
    setIsQuickCreateOpen(true)
  }, [])

  const handleImport = useCallback((importMethod: ImportMethod) => {
    setIsAddMenuOpen(false)
    setModalType(importMethod)
    setIsAddModalVisible(true)
  }, [])

  const isCatalog = variant === 'catalog'
  const selectedServer = selectedServerId ? mcpServers.find((server) => server.id === selectedServerId) : undefined

  const addServerMenu = (
    <Popover open={isAddMenuOpen} onOpenChange={setIsAddMenuOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm">
          <Plus className="size-3" />
          {t('common.add')}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-auto p-1">
        <MenuList className="gap-1">
          <MenuItem label={t('settings.mcp.addServer.create')} onClick={handleManualAdd} />
          <MenuItem label={t('settings.mcp.addServer.importFrom.json')} onClick={() => handleImport('json')} />
          <MenuItem label={t('settings.mcp.addServer.importFrom.dxt')} onClick={() => handleImport('dxt')} />
          <MenuItem label={t('settings.mcp.addServer.importFrom.mcpb')} onClick={() => handleImport('mcpb')} />
        </MenuList>
      </PopoverContent>
    </Popover>
  )

  const catalogFilters = (
    <div role="tablist" aria-label={t('settings.mcp.filter.label')} className="flex min-w-0 flex-wrap gap-1">
      {FILTER_OPTIONS.map((option) => (
        <Button
          key={option.value}
          role="tab"
          aria-selected={filter === option.value}
          variant={filter === option.value ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 rounded-md px-3 font-normal"
          onClick={() => setFilter(option.value)}>
          {option.label ?? t(option.labelKey!)}
        </Button>
      ))}
    </div>
  )

  const headerActions = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <EnvironmentDependencies mini />
      {isCatalog ? (
        <CollapsibleSearchBar
          onSearch={setSearchText}
          placeholder={t('settings.mcp.search.placeholder')}
          tooltip={t('settings.mcp.search.tooltip')}
          maxWidth={256}
          collapsedSize={32}
          animated={false}
        />
      ) : null}
      {addServerMenu}
    </div>
  )

  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-1 flex-col overflow-hidden px-6 pb-6',
        isCatalog ? 'h-full pt-7' : 'h-[calc(100vh-var(--navbar-height))] gap-2 pt-3'
      )}>
      <div className={cn('mx-auto flex min-h-0 w-full flex-1 flex-col', isCatalog ? 'max-w-none' : 'max-w-3xl')}>
        {isCatalog ? (
          <div className="mb-4 flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {showTitle ? (
                <div className="flex items-baseline gap-2">
                  <SettingTitle className="m-0 font-semibold text-xl">{t('settings.mcp.allServers')}</SettingTitle>
                  <span className="text-foreground-tertiary text-xs">{mcpServers.length}</span>
                </div>
              ) : null}
              {catalogFilters}
            </div>
            {headerActions}
          </div>
        ) : (
          <div className="mb-3 flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {showTitle ? <SettingTitle className="m-0">{t('settings.mcp.allServers')}</SettingTitle> : null}
              <div className="flex shrink-0 items-center gap-1">
                <Popover open={isFilterMenuOpen} onOpenChange={setIsFilterMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('settings.mcp.filter.label')}
                      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-accent">
                      <Filter
                        size={14}
                        color={filter === 'all' ? 'var(--muted-foreground)' : undefined}
                        className={filter === 'all' ? undefined : 'text-primary'}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="bottom" className="w-auto min-w-36 p-1">
                    <MenuList className="gap-1">
                      {FILTER_OPTIONS.map((option) => (
                        <MenuItem
                          key={option.value}
                          label={option.label ?? t(option.labelKey!)}
                          className="h-8 rounded-lg px-2.5 text-sm"
                          icon={
                            <Check
                              className={filter === option.value ? 'size-3.5 opacity-100' : 'size-3.5 opacity-0'}
                            />
                          }
                          onClick={() => {
                            setFilter(option.value)
                            setIsFilterMenuOpen(false)
                          }}
                        />
                      ))}
                    </MenuList>
                  </PopoverContent>
                </Popover>
                <CollapsibleSearchBar
                  onSearch={setSearchText}
                  placeholder={t('settings.mcp.search.placeholder')}
                  tooltip={t('settings.mcp.search.tooltip')}
                  maxWidth={200}
                  collapsedSize={28}
                  animated={false}
                  style={{ borderRadius: 14 }}
                />
              </div>
            </div>
            {headerActions}
          </div>
        )}
        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              <Scrollbar ref={scrollRef} className={cn('min-h-0 flex-1', isCatalog && '@container/connectors')}>
                {filteredMcpServers.length > 0 ? (
                  <Sortable
                    className={cn(
                      isCatalog
                        ? 'grid @[1120px]/connectors:grid-cols-4 @[560px]/connectors:grid-cols-2 @[840px]/connectors:grid-cols-3 grid-cols-1 gap-3'
                        : '[&>div:last-child_[data-slot=mcp-server-row]]:border-b-0'
                    )}
                    items={filteredMcpServers}
                    itemKey="id"
                    onSortEnd={onSortEnd}
                    layout={isCatalog ? 'grid' : 'list'}
                    horizontal={false}
                    listStyle={isCatalog ? undefined : { gap: 0 }}
                    itemStyle={{ transition: 'none' }}
                    restrictions={{ scrollableAncestor: true }}
                    useDragOverlay
                    showGhost
                    renderItem={(server) => (
                      <McpServerCard
                        server={server}
                        variant={variant}
                        onEdit={() =>
                          isCatalog
                            ? setSelectedServerId(server.id)
                            : navigate({ to: `/settings/mcp/settings/${server.id}` })
                        }
                      />
                    )}
                  />
                ) : (
                  <EmptyState
                    compact
                    preset="no-resource"
                    description={mcpServers.length === 0 ? t('settings.mcp.noServers') : t('common.no_results')}
                    className="py-12"
                  />
                )}
              </Scrollbar>
            </div>
          </div>
        </div>
      </div>

      <QuickCreateMcpServerDialog
        open={isQuickCreateOpen}
        onOpenChange={setIsQuickCreateOpen}
        existingServers={mcpServers}
        onCreate={handleQuickCreate}
      />

      <AddMcpServerModal
        visible={isAddModalVisible}
        onClose={() => setIsAddModalVisible(false)}
        onSuccess={handleAddServerSuccess}
        existingServers={mcpServers} // 傳遞現有的伺服器列表
        initialImportMethod={modalType}
      />

      {protocolInstallRequest && (
        <McpProtocolInstallDialog
          key={protocolInstallRequest.requestId}
          servers={protocolInstallRequest.servers}
          onClose={handleProtocolInstallClose}
          onInstall={handleProtocolInstall}
        />
      )}

      <Dialog open={Boolean(selectedServer)} onOpenChange={(open) => !open && setSelectedServerId(null)}>
        <DialogContent
          size="xl"
          showCloseButton={false}
          className="h-[80vh] max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">{selectedServer?.name}</DialogTitle>
          {selectedServer ? (
            <div className="min-h-0 overflow-hidden">
              <McpSettings serverId={selectedServer.id} onClose={() => setSelectedServerId(null)} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default McpServersList
