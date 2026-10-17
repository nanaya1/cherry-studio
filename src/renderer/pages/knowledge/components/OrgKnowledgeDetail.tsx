import { ArrowLeft, BookOpen, Check, CircleAlert, Eye, FileText, LoaderCircle } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

// import { Badge } from '@cherrystudio/ui'
import { Button, Input, PageHeader } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import { FilePreviewLayout, PdfFilePreview } from '@renderer/components/FilePreview'
import { ipcApi } from '@renderer/ipc'
import { formatRelativeTime } from '@renderer/utils/time'
import type { OrgKnowledgeBase, OrgKnowledgeSearchChunk } from '@shared/data/types/enterpriseKnowledge'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import { KNOWLEDGE_ITEM_ROW_GRID } from '../panels/dataSource/styles'
import { dataSourceTypeDisplayConfig } from '../panels/dataSource/utils/models'
import { previewText } from '../utils/sharing'
import KnowledgeRowActionsMenu from './KnowledgeRowActionsMenu'
import KnowledgeSharingPanel from './KnowledgeSharingPanel'

const logger = loggerService.withContext('OrgKnowledgeDetail')

type DocumentTarget = {
  itemId?: string
  documentId: string
  fileId?: string
  chunkId?: string
  title: string
  mode?: 'read' | 'chunks' | 'preview'
}

function DocumentView({ baseId, target, onBack }: { baseId: string; target: DocumentTarget; onBack: () => void }) {
  const { t } = useTranslation()
  // 行操作直接进入对应视图，搜索结果仍默认阅读正文。
  const [mode] = useState<'read' | 'chunks' | 'preview'>(target.mode ?? 'read')
  const [cursor, setCursor] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (mode === 'chunks' && target.itemId)
      return {
        mode: 'chunks' as const,
        value: await ipcApi.request('enterprise.knowledge.chunks', { baseId, itemId: target.itemId, cursor })
      }
    if (mode === 'preview') {
      // MEA:enterprise-knowledge-page 只使用主进程确认的文件映射。
      let fileId = target.fileId
      let nextCursor: string | null = null
      if (!fileId && !target.itemId) {
        do {
          const page = await ipcApi.request('enterprise.knowledge.items', { baseId, cursor: nextCursor })
          fileId = page.items.find((item) => item.documentId === target.documentId)?.fileId ?? undefined
          nextCursor = page.nextCursor
        } while (!fileId && nextCursor)
      }
      logger.info('knowledge preview file mapping', {
        baseId,
        itemId: target.itemId,
        documentId: target.documentId,
        fileId: fileId ?? null
      })
      if (!fileId) return { mode: 'unavailable' as const }
      return {
        mode: 'preview' as const,
        value: await ipcApi.request('enterprise.knowledge.preview', { fileId })
      }
    }
    return {
      mode: 'read' as const,
      value: await ipcApi.request('enterprise.knowledge.read', {
        baseId,
        documentId: target.documentId,
        chunkId: target.chunkId
      })
    }
  }, [baseId, target, mode, cursor])
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  return (
    <section
      aria-label={target.title}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pt-3 pb-4">
      <FilePreviewLayout.Frame>
        <div className="relative flex h-11 min-h-11 shrink-0 items-center gap-2 px-3 after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-3 after:border-b after:border-border after:content-['']">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.back')}
            className="size-6 min-h-6 min-w-6 rounded p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            onClick={onBack}>
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{target.title}</span>
          {mode === 'chunks' && data?.mode === 'chunks' ? (
            <span className="text-xs text-foreground-tertiary">
              {t('knowledge.data_source.chunks_count', { count: data.value.total })}
            </span>
          ) : null}
          {/* 原视图切换操作保留，统一从文件列表菜单进入。

        <Button variant="outline" onClick={() => setMode('read')}>
          {t('knowledge.org.read')}
        </Button>
        {target.itemId ? (
          <Button
            variant="outline"
            onClick={() => {
              setCursor(null)
              setMode('chunks')
            }}>
            {t('knowledge.org.chunks')}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => setMode('preview')}>
          {t('knowledge.org.preview')}
        </Button>
        */}
        </div>
        <FilePreviewLayout.Content>
          {loading ? (
            <p role="status">{t('common.loading')}</p>
          ) : error ? (
            <div role="alert">
              <p className="text-error">{error}</p>
              <Button onClick={() => void refresh()}>{t('knowledge.org.refresh')}</Button>
            </div>
          ) : data?.mode === 'chunks' ? (
            <>
              {/* 分块数量移至与本地一致的紧凑标题栏。 */}
              {data.value.chunks.length === 0 ? (
                <p>{t('knowledge.org.empty_chunks')}</p>
              ) : (
                data.value.chunks.map((chunk) => (
                  <article
                    key={chunk.id}
                    className="mx-4 my-2 rounded-lg border border-border-subtle transition-all hover:border-border-strong">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-accent text-xs leading-4 text-foreground-tertiary">
                        {chunk.chunkIndex + 1}
                      </span>
                      {typeof chunk.metadata?.tokenCount === 'number' ? (
                        <span className="text-xs text-foreground-tertiary">
                          {chunk.metadata.tokenCount} {t('knowledge.rag.tokens_unit')}
                        </span>
                      ) : null}
                    </div>
                    <div className="px-3 pb-3">
                      <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{chunk.content}</p>
                    </div>
                  </article>
                ))
              )}
              {cursor ? (
                <Button variant="outline" onClick={() => setCursor(null)}>
                  {t('knowledge.org.first_page')}
                </Button>
              ) : null}
              {data.value.nextCursor ? (
                <Button variant="outline" onClick={() => setCursor(data.value.nextCursor)}>
                  {t('knowledge.org.next_page')}
                </Button>
              ) : null}
            </>
          ) : data?.mode === 'unavailable' ? (
            <p role="status" className="text-muted-foreground">
              {t('knowledge.org.preview_unavailable')}
            </p>
          ) : data?.mode === 'preview' ? (
            <>
              {/* 文件名统一显示在预览标题栏。 */}
              {data.value.kind === 'inline' && data.value.base64 && data.value.mimeType === 'application/pdf' ? (
                <PdfFilePreview fileName={data.value.fileName} base64={data.value.base64} />
              ) : data.value.kind === 'inline' &&
                (data.value.url || data.value.base64) &&
                ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(
                  data.value.mimeType ?? ''
                ) ? (
                <img
                  alt={data.value.fileName}
                  className="mx-auto max-h-full max-w-full object-contain"
                  referrerPolicy="no-referrer"
                  src={data.value.url ?? `data:${data.value.mimeType};base64,${data.value.base64}`}
                />
              ) : previewText(data.value) === null ? (
                <p role="status" className="text-muted-foreground">
                  {t('knowledge.org.preview_unavailable')}
                </p>
              ) : (
                <article className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">
                  {previewText(data.value) || t('knowledge.org.empty_content')}
                </article>
              )}
            </>
          ) : data?.mode === 'read' ? (
            <>
              <article className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">
                {data.value.content || t('knowledge.org.empty_content')}
              </article>
              {data.value.truncated ? <p className="text-warning">{t('knowledge.org.truncated')}</p> : null}
            </>
          ) : null}
        </FilePreviewLayout.Content>
      </FilePreviewLayout.Frame>
    </section>
  )
}

function SearchPanel({ baseId, onOpen }: { baseId: string; onOpen: (target: DocumentTarget) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  return (
    <section className="space-y-4 p-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) setSubmitted(query.trim())
        }}>
        <Input
          aria-label={t('knowledge.org.query')}
          maxLength={1000}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button disabled={!query.trim()}>{t('knowledge.org.search')}</Button>
      </form>
      {submitted ? <SearchResults key={submitted} baseId={baseId} query={submitted} onOpen={onOpen} /> : null}
    </section>
  )
}

function SearchResults({
  baseId,
  query,
  onOpen
}: {
  baseId: string
  query: string
  onOpen: (target: DocumentTarget) => void
}) {
  const { t } = useTranslation()
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.search', { baseIds: [baseId], query, topK: 10 }),
    [baseId, query]
  )
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  return (
    <div className="space-y-3">
      {loading ? <p role="status">{t('common.loading')}</p> : null}
      {error ? (
        <div role="alert">
          <p className="text-error">{error}</p>
          <Button onClick={() => void refresh()}>{t('knowledge.org.refresh')}</Button>
        </div>
      ) : null}
      {data?.chunks.length === 0 ? <p>{t('knowledge.org.empty_results')}</p> : null}
      {data?.chunks.map((chunk: OrgKnowledgeSearchChunk) => (
        <article key={chunk.chunkId} className="space-y-2 rounded border border-border p-3">
          <h3>{chunk.title}</h3>
          <p className="whitespace-pre-wrap break-words">{chunk.content}</p>
          <p className="text-sm text-muted-foreground">
            {t('knowledge.org.score')}: {chunk.score}
          </p>
          <Button
            variant="outline"
            onClick={() => onOpen({ documentId: chunk.documentId, chunkId: chunk.chunkId, title: chunk.title })}>
            {t('knowledge.org.read')}
          </Button>
        </article>
      ))}
    </div>
  )
}

export default function OrgKnowledgeDetail({ base, owned }: { base: OrgKnowledgeBase; owned: boolean }) {
  const {
    t,
    i18n: { language }
  } = useTranslation()
  // const [tab, setTab] = useState<'documents' | 'search' | 'members'>('documents')
  const [tab] = useState<'documents' | 'search' | 'members'>('documents')
  const [cursor, setCursor] = useState<string | null>(null)
  const [target, setTarget] = useState<DocumentTarget | null>(null)
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.items', { baseId: base.id, cursor }),
    [base.id, cursor]
  )
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  if (target)
    return (
      <main data-ui="knowledge.content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DocumentView
          key={`${target.documentId}-${target.chunkId ?? ''}-${target.mode ?? 'read'}`}
          baseId={base.id}
          target={target}
          onBack={() => setTarget(null)}
        />
      </main>
    )
  return (
    <main data-ui="knowledge.content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        titleClassName="text-2xl leading-8 font-semibold tracking-tight"
        className="mt-0 mb-0 h-auto min-h-20 flex-wrap gap-3 border-b border-border px-6 py-5"
        title={base.name}
        // action={<Badge variant="outline">{t('knowledge.org.readonly')}</Badge>}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 原说明与页签保留，详情直接展示文件列表。
        <div className="space-y-1 px-6 py-4">
          <p className="text-sm text-muted-foreground">{base.description}</p>
          <p className="text-sm text-muted-foreground">
            {t('knowledge.org.document_total', { count: base.documentCount })}
          </p>
          <p className="text-sm text-muted-foreground">{t('knowledge.org.readonly_notice')}</p>
        </div>
        <div className="mx-6 flex flex-wrap gap-2 border-b border-border pb-3">
          <Button
            variant={tab === 'documents' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTarget(null)
              setTab('documents')
            }}>
            {t('knowledge.org.documents')}
          </Button>
          <Button
            variant={tab === 'search' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTarget(null)
              setTab('search')
            }}>
            {t('knowledge.org.search')}
          </Button>
          {owned ? (
            <Button
              variant={tab === 'members' ? 'secondary' : 'ghost'}
              onClick={() => {
                setTarget(null)
                setTab('members')
              }}>
              {t('knowledge.org.shares')}
            </Button>
          ) : null}
        </div>
        */}
        {tab === 'members' && owned ? (
          <KnowledgeSharingPanel key={base.id} baseId={base.id} name={base.name} />
        ) : tab === 'search' ? (
          <SearchPanel baseId={base.id} onOpen={setTarget} />
        ) : (
          <section className="space-y-3 px-6 pt-3 pb-4" aria-label={t('knowledge.org.documents')}>
            {loading ? (
              <p role="status">{t('common.loading')}</p>
            ) : error ? (
              <div role="alert">
                <p className="text-error">{error}</p>
                <Button onClick={() => void refresh()}>{t('knowledge.org.refresh')}</Button>
              </div>
            ) : (
              <>
                {data?.items.length === 0 ? (
                  <p className="text-muted-foreground">{t('knowledge.org.empty_documents')}</p>
                ) : null}
                {/* 原纵向文件列表保留，改用与本地一致的分列表格。
                {data?.items.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center gap-3 border-b border-border py-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words">{item.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.type} · {item.status} · {item.updatedAt}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={!item.documentId}
                      onClick={() => {
                        if (item.documentId)
                          setTarget({
                            itemId: item.id,
                            documentId: item.documentId,
                            fileId: item.fileId ?? undefined,
                            title: item.title
                          })
                      }}>
                      {t('knowledge.org.read')}
                    </Button>
                  </div>
                ))}
                */}
                {data?.items.length ? (
                  <div role="grid" aria-label={t('knowledge.data_source.table.aria_label')} className="-mx-3">
                    <div role="row" className={cn(KNOWLEDGE_ITEM_ROW_GRID, 'mb-2 h-11 border-b border-border px-2.5')}>
                      <div role="columnheader" aria-label={t('knowledge.org.readonly')} />
                      {(['name', 'type', 'status', 'updated_at', 'actions'] as const).map((column) => (
                        <div
                          key={column}
                          role="columnheader"
                          className="min-w-0 text-xs font-medium text-foreground-tertiary">
                          {column === 'actions' ? (
                            <span className="sr-only">{t('knowledge.data_source.table.columns.actions')}</span>
                          ) : (
                            {
                              name: t('knowledge.data_source.table.columns.name'),
                              type: t('knowledge.data_source.table.columns.type'),
                              status: t('knowledge.data_source.table.columns.status'),
                              updated_at: t('knowledge.data_source.table.columns.updated_at')
                            }[column]
                          )}
                        </div>
                      ))}
                    </div>
                    <div role="rowgroup" className="space-y-1.5">
                      {data.items.map((item) => {
                        const typeConfig = Object.entries(dataSourceTypeDisplayConfig).find(
                          ([type]) => type === item.type
                        )?.[1]
                        const Icon = typeConfig?.icon.icon ?? FileText
                        const ready = item.status === 'ready' || item.status === 'completed'
                        const failed = item.status === 'failed'
                        const StatusIcon = ready ? Check : failed ? CircleAlert : LoaderCircle
                        const openDocument = (mode: 'preview' | 'chunks' = 'preview') => {
                          if (item.documentId)
                            setTarget({
                              itemId: item.id,
                              documentId: item.documentId,
                              fileId: item.fileId ?? undefined,
                              title: item.title,
                              mode
                            })
                        }
                        const actions: CommandContextMenuExtraItem[] = [
                          {
                            type: 'item',
                            id: 'preview-source',
                            label: t('knowledge.data_source.actions.preview_source'),
                            icon: <BookOpen className="size-3.5" />,
                            enabled: !!item.documentId,
                            onSelect: () => openDocument('preview')
                          }
                        ]
                        if (ready && item.documentId)
                          actions.push({
                            type: 'item',
                            id: 'view-chunks',
                            label: t('knowledge.data_source.actions.view_chunks'),
                            icon: <Eye className="size-3.5" />,
                            onSelect: () => openDocument('chunks')
                          })
                        return (
                          <CommandContextMenu key={item.id} location="webcontents.context" extraItems={actions}>
                            <div
                              key={item.id}
                              role="row"
                              tabIndex={item.documentId ? 0 : undefined}
                              aria-label={t('knowledge.data_source.table.open_row', { title: item.title })}
                              onClick={() => openDocument()}
                              onKeyDown={(event) => {
                                if (
                                  event.target === event.currentTarget &&
                                  (event.key === 'Enter' || event.key === ' ')
                                ) {
                                  event.preventDefault()
                                  openDocument()
                                }
                              }}
                              className={cn(
                                KNOWLEDGE_ITEM_ROW_GRID,
                                'group/row min-h-11 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted',
                                item.documentId && 'cursor-pointer focus-visible:bg-muted focus-visible:outline-none'
                              )}>
                              <div role="gridcell" />
                              <div role="gridcell" className="flex min-w-0 items-center gap-2">
                                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-background-subtle">
                                  <Icon className={cn('size-3.5', typeConfig?.icon.iconClassName)} />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={item.title}>
                                  {item.title}
                                </span>
                              </div>
                              <div role="gridcell" className="truncate text-xs text-muted-foreground">
                                {typeConfig ? t(typeConfig.filterLabelKey) : item.type}
                              </div>
                              <div role="gridcell">
                                <span
                                  className={cn(
                                    'inline-flex items-center gap-1 text-xs',
                                    ready ? 'text-success' : failed ? 'text-error' : 'text-info'
                                  )}>
                                  <StatusIcon
                                    className={cn(
                                      'size-3',
                                      !ready && !failed && 'animate-spin motion-reduce:animate-none'
                                    )}
                                  />
                                  {ready
                                    ? t('knowledge.data_source.status.ready')
                                    : failed
                                      ? t('knowledge.data_source.status.error')
                                      : item.status}
                                </span>
                              </div>
                              <div
                                role="gridcell"
                                className="truncate text-xs text-muted-foreground"
                                title={item.updatedAt}>
                                {Number.isFinite(Date.parse(item.updatedAt))
                                  ? formatRelativeTime(item.updatedAt, language)
                                  : '—'}
                              </div>
                              <div role="gridcell">
                                {/* 原单一阅读入口改为与本地相同的操作菜单。
                              <Button variant="ghost" onClick={() => openDocument()}>{t('knowledge.org.read')}</Button>
                              */}
                                <KnowledgeRowActionsMenu items={actions} />
                              </div>
                            </div>
                          </CommandContextMenu>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
                {cursor ? (
                  <Button variant="outline" onClick={() => setCursor(null)}>
                    {t('knowledge.org.first_page')}
                  </Button>
                ) : null}
                {data?.nextCursor ? (
                  <Button variant="outline" onClick={() => setCursor(data.nextCursor)}>
                    {t('knowledge.org.next_page')}
                  </Button>
                ) : null}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
