import {
  Alert,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Scrollbar,
  Skeleton
} from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { ResourceDeleteConfirmDialog } from '@renderer/components/resourceCatalog/dialogs/delete'
import type { useResourceCatalogController } from '@renderer/hooks/resourceCatalog'
import { ipcApi } from '@renderer/ipc'
import type { ResourceItem } from '@renderer/types/resourceCatalog'
import { cn } from '@renderer/utils/style'
import { ChevronDown, FolderSearch, Import, Plus, Search, Trash2 } from 'lucide-react'
import { type KeyboardEvent, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ResourceCatalogSearchInput } from '../ResourceCatalogSearchInput'

const ResourceCatalogDialogs = lazy(() =>
  import('./ResourceCatalogDialogs').then((module) => ({ default: module.ResourceCatalogDialogs }))
)

const logger = loggerService.withContext('SkillCatalogView')

export type SkillSourceFilter = 'all' | 'builtin' | 'marketplace' | 'custom'
type SkillResource = Extract<ResourceItem, { type: 'skill' }>
type SkillController = ReturnType<typeof useResourceCatalogController>

const CUSTOM_SKILL_SOURCES = new Set(['local', 'zip', 'system'])
const FALLBACK_STYLES = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/15 text-chart-2',
  'bg-chart-3/15 text-chart-3',
  'bg-chart-4/15 text-chart-4',
  'bg-chart-5/15 text-chart-5',
  'bg-info-subtle text-info-subtle-foreground',
  'bg-success-subtle text-success-subtle-foreground',
  'bg-warning-subtle text-warning-subtle-foreground',
  'bg-error-subtle text-error-subtle-foreground'
]

export function getSkillSourceFilter(source: string): Exclude<SkillSourceFilter, 'all'> | null {
  if (source === 'builtin') return 'builtin'
  if (source === 'marketplace') return 'marketplace'
  if (CUSTOM_SKILL_SOURCES.has(source)) return 'custom'
  return null
}

export function getSkillInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function getSkillFallbackStyle(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return FALLBACK_STYLES[hash % FALLBACK_STYLES.length]
}

export function SkillCatalogHeaderActions({ controller }: { controller: SkillController }) {
  const { t } = useTranslation()
  const { gridProps } = controller

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ResourceCatalogSearchInput
        value={gridProps.search}
        onValueChange={gridProps.onSearchChange}
        placeholder={t('library.toolbar.search_placeholder')}
        className="w-64 max-w-[32vw] max-lg:w-40"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" className="shrink-0">
            <Plus className="size-3.5" />
            <span className="max-lg:sr-only">{t('library.skill_add.add')}</span>
            <ChevronDown className="size-3.5 max-lg:hidden" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onSelect={gridProps.onOpenSkillMarketplace} className="gap-2">
            <Search className="size-3.5" />
            <span>{t('library.skill_add.online_search')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={gridProps.onOpenSystemSkills} className="gap-2">
            <FolderSearch className="size-3.5" />
            <span>{t('library.skill_add.system_search')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => gridProps.onCreate('skill')} className="gap-2">
            <Import className="size-3.5" />
            <span>{t('library.skill_add.local_import')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function SkillCatalogView({ controller }: { controller: SkillController }) {
  const { t } = useTranslation()
  const { resourceError, refetch, gridProps, dialogs } = controller
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>('all')
  const [iconUrls, setIconUrls] = useState<Record<string, string>>({})
  const resources = gridProps.resources.filter((resource): resource is SkillResource => resource.type === 'skill')
  const iconSkillIds = useMemo(
    () =>
      gridProps.allResources
        .filter(
          (resource): resource is SkillResource => resource.type === 'skill' && Boolean(resource.raw.iconFileName)
        )
        .map((resource) => resource.id),
    [gridProps.allResources]
  )

  useEffect(() => {
    let cancelled = false
    if (iconSkillIds.length === 0) {
      setIconUrls({})
      return
    }

    ipcApi
      .request('skill.icons.resolve', { skillIds: iconSkillIds })
      .then((urls) => {
        if (!cancelled) setIconUrls(urls)
      })
      .catch((error) => {
        if (!cancelled) setIconUrls({})
        logger.warn('Failed to resolve skill icons', { error })
      })
    return () => {
      cancelled = true
    }
  }, [iconSkillIds])

  const counts = useMemo(() => {
    const next: Record<SkillSourceFilter, number> = { all: resources.length, builtin: 0, marketplace: 0, custom: 0 }
    for (const resource of resources) {
      const group = getSkillSourceFilter(resource.raw.source)
      if (group) next[group] += 1
    }
    return next
  }, [resources])

  const visibleResources = useMemo(
    () =>
      sourceFilter === 'all'
        ? resources
        : resources.filter((resource) => getSkillSourceFilter(resource.raw.source) === sourceFilter),
    [resources, sourceFilter]
  )

  const filters: Array<{ value: SkillSourceFilter; label: string }> = [
    { value: 'all', label: t('common.all') },
    { value: 'builtin', label: t('workspace.skillsConnectors.sources.builtin') },
    { value: 'marketplace', label: t('workspace.skillsConnectors.sources.marketplace') },
    { value: 'custom', label: t('workspace.skillsConnectors.sources.custom') }
  ]
  const hasSearch = Boolean(gridProps.search.trim())

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {resourceError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Alert
            type="error"
            showIcon
            message={t('common.error')}
            description={resourceError.message}
            action={
              <Button variant="outline" size="sm" onClick={refetch}>
                {t('common.retry')}
              </Button>
            }
            className="max-w-lg rounded-md px-4 py-3 shadow-none"
          />
        </div>
      ) : (
        <>
          <div className="shrink-0 px-6 pt-7 pb-4">
            <div className="flex items-baseline gap-2">
              <h2 className="font-semibold text-xl">{t('workspace.skillsConnectors.mySkills')}</h2>
              <span className="text-foreground-tertiary text-xs">
                {gridProps.allResources.length} {t('settings.skills.installed')}
              </span>
            </div>
            <div className="mt-4 flex w-full flex-wrap items-center justify-between gap-3">
              <div
                role="tablist"
                aria-label={t('workspace.skillsConnectors.sourceFilter')}
                className="flex min-w-0 flex-wrap gap-1">
                {filters.map((filter) => (
                  <Button
                    key={filter.value}
                    role="tab"
                    aria-selected={sourceFilter === filter.value}
                    variant={sourceFilter === filter.value ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setSourceFilter(filter.value)}
                    className="h-8 gap-1.5 rounded-md px-3 font-normal">
                    <span>{filter.label}</span>
                    <span className="text-foreground-tertiary text-xs tabular-nums">{counts[filter.value]}</span>
                  </Button>
                ))}
              </div>
              <SkillCatalogHeaderActions controller={controller} />
            </div>
          </div>

          <Scrollbar className="@container/skills min-h-0 flex-1 px-6 pb-6">
            {gridProps.isLoading ? (
              <SkillGridLoading />
            ) : visibleResources.length === 0 ? (
              <EmptyState
                preset={hasSearch ? 'no-result' : 'no-resource'}
                title={hasSearch ? t('library.empty_state.no_match_title') : t('library.empty_state.title')}
                description={
                  hasSearch ? t('library.empty_state.no_match_description') : t('library.empty_state.description')
                }
                className="py-20"
              />
            ) : (
              <div
                className="grid @[1120px]/skills:grid-cols-4 @[560px]/skills:grid-cols-2 @[840px]/skills:grid-cols-3 grid-cols-1 gap-3"
                role="list">
                {visibleResources.map((resource) => (
                  <SkillCard
                    key={resource.id}
                    resource={resource}
                    iconUrl={iconUrls[resource.id]}
                    onOpen={() => gridProps.onEdit(resource)}
                    onDelete={() => gridProps.onDelete(resource)}
                  />
                ))}
              </div>
            )}
          </Scrollbar>
        </>
      )}

      <ResourceDeleteConfirmDialog resource={dialogs.deleteConfirm} onClose={() => dialogs.setDeleteConfirm(null)} />
      <Suspense fallback={null}>
        <ResourceCatalogDialogs dialogs={dialogs} onRefetch={refetch} resourceType="skill" />
      </Suspense>
    </div>
  )
}

function SkillCard({
  resource,
  iconUrl,
  onOpen,
  onDelete
}: {
  resource: SkillResource
  iconUrl?: string
  onOpen: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const initial = getSkillInitial(resource.name)
  const fallbackStyle = getSkillFallbackStyle(resource.name)
  const version = resource.raw.version?.trim()

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onOpen()
  }

  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={resource.name}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className="group relative min-h-28 cursor-pointer rounded-lg border border-border-subtle bg-card p-3.5 transition-[background-color,border-color,box-shadow] hover:border-border-strong hover:bg-background-subtle hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <div className="flex min-w-0 items-center gap-2.5 pr-7">
        <Avatar className="size-8 shrink-0 rounded-full">
          {iconUrl ? (
            <AvatarImage src={iconUrl} alt="" className="rounded-full object-cover" draggable={false} />
          ) : null}
          <AvatarFallback className={cn('rounded-full font-semibold text-sm', fallbackStyle)}>{initial}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-semibold text-base leading-5">{resource.name}</h3>
          {version ? (
            <Badge
              variant="secondary"
              className="shrink-0 border-0 px-1.5 py-px font-normal text-[10px] text-foreground-tertiary">
              {version}
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-muted-foreground text-sm leading-5">{resource.description}</p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('library.action.uninstall')}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
        className="absolute top-3.5 right-3 text-muted-foreground opacity-0 hover:bg-error-subtle hover:text-error-subtle-foreground focus-visible:opacity-100 group-hover:opacity-100">
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

function SkillGridLoading() {
  return (
    <div
      className="grid @[1120px]/skills:grid-cols-4 @[560px]/skills:grid-cols-2 @[840px]/skills:grid-cols-3 grid-cols-1 gap-3"
      data-testid="skill-grid-loading">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="min-h-28 rounded-lg border border-border-subtle bg-card p-3.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="mt-3 space-y-2.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
