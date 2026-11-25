import { ArrowLeft } from 'lucide-react'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
// eslint-disable-next-line barrel/closed -- Keep PDF.js out of the list's initial bundle.
import { FilePreviewLayout } from '@renderer/components/FilePreview/FilePreviewLayout'
import { ipcApi } from '@renderer/ipc'
import { type KnowledgeItem, KnowledgeRelativePathSchema } from '@shared/data/types/knowledge'
import type { InspectionFile } from '@shared/data/types/knowledgeInspection'
import { sanitizeFilename } from '@shared/utils/file'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import KnowledgeItemList from '../panels/dataSource/KnowledgeItemList'
import InspectionPager from './InspectionPager'
import InspectionQueryState from './InspectionQueryState'
import { KnowledgeChunkCard, KnowledgeParsedContent } from './KnowledgeDocumentContent'
import KnowledgeFilePagination from './KnowledgeFilePagination'
import KnowledgePanelShell from './KnowledgePanelShell'

const noSelection = new Set<string>()
const noop = () => undefined
const remoteDisplayPath = KnowledgeRelativePathSchema.parse('document')
// eslint-disable-next-line barrel/closed -- Load PDF.js only when opening an original preview.
const PdfFilePreview = lazy(() => import('@renderer/components/FilePreview/plugins/pdf/PdfFilePreview'))

function toRow(baseId: string, file: InspectionFile): KnowledgeItem {
  const meta = { id: file.id, baseId, createdAt: '', updatedAt: file.updateTime ?? '' }
  if (file.directory) return { ...meta, type: 'directory', status: 'idle', error: null, data: { source: file.name } }
  const displayPath = KnowledgeRelativePathSchema.safeParse(sanitizeFilename(file.name))
  const data = { source: file.name, relativePath: displayPath.data ?? remoteDisplayPath }
  if (file.parseStatus === 'failed') return { ...meta, type: 'file', status: 'failed', error: '—', data }
  return { ...meta, type: 'file', status: file.parseStatus === 'ready' ? 'completed' : 'processing', error: null, data }
}

type FileMode = 'preview' | 'content' | 'chunks'
export type InspectionFileTarget = { file: InspectionFile; mode: FileMode }

export function InspectionFileDetail({
  baseId,
  file,
  initialMode,
  onBack
}: {
  baseId: string
  file: InspectionFile
  initialMode: FileMode
  onBack: () => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState(initialMode)
  const [page, setPage] = useState(1)
  const loadContent = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.content', { baseId, fileId: file.id }),
    [baseId, file.id]
  )
  return (
    <section
      aria-label={file.name}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pt-3 pb-4">
      <FilePreviewLayout.Frame>
        <div className="relative flex min-h-11 shrink-0 flex-wrap items-center gap-2 px-3 after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-3 after:border-b after:border-border after:content-['']">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 min-h-6 min-w-6 rounded p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            aria-label={t('common.back')}
            onClick={onBack}>
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={file.name}>
            {file.name}
          </span>
          {(
            [
              ...(file.hasOriginalFile ? ['preview'] : []),
              ...(file.parseStatus === 'ready' ? ['content', 'chunks'] : [])
            ] as FileMode[]
          ).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? 'secondary' : 'ghost'}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}>
              {t(
                value === 'preview'
                  ? 'knowledge.org.preview'
                  : value === 'content'
                    ? 'knowledge.inspection.content'
                    : 'knowledge.inspection.chunks'
              )}
            </Button>
          ))}
        </div>
        <FilePreviewLayout.Content>
          {mode === 'preview' ? (
            <InspectionPreview baseId={baseId} fileId={file.id} />
          ) : (
            <div className={mode === 'chunks' ? 'space-y-2 px-4 py-3' : undefined}>
              {mode === 'content' ? (
                <InspectionContent load={loadContent} />
              ) : (
                <InspectionChunks baseId={baseId} fileId={file.id} page={page} onPage={setPage} />
              )}
            </div>
          )}
        </FilePreviewLayout.Content>
      </FilePreviewLayout.Frame>
    </section>
  )
}

function InspectionPreview({ baseId, fileId }: { baseId: string; fileId: string }) {
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.preview', { baseId, fileId }),
    [baseId, fileId]
  )
  const query = useInspectionQuery(load)
  return query.data ? (
    <Suspense fallback={<InspectionQueryState {...query} loading />}>
      <PdfFilePreview fileName={query.data.fileName} url={query.data.minioPreviewUrl} />
    </Suspense>
  ) : (
    <InspectionQueryState {...query} />
  )
}

function InspectionContent({
  load
}: {
  load: () => ReturnType<typeof ipcApi.request<'enterprise.knowledge.inspection.content'>>
}) {
  const query = useInspectionQuery(load)
  return (
    <>
      <InspectionQueryState {...query} />
      {query.data ? <KnowledgeParsedContent content={query.data.content} truncated={query.data.truncated} /> : null}
    </>
  )
}

function InspectionChunks({
  baseId,
  fileId,
  page,
  onPage
}: {
  baseId: string
  fileId: string
  page: number
  onPage: (page: number) => void
}) {
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.chunks', { baseId, fileId, page }),
    [baseId, fileId, page]
  )
  const query = useInspectionQuery(load)
  return (
    <>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.map((chunk) => (
            <KnowledgeChunkCard key={chunk.id} index={chunk.chunkIndex} content={chunk.content} fullText />
          ))}
          <InspectionPager page={page} pageSize={query.data.pageSize} total={query.data.total} onChange={onPage} />
        </>
      ) : null}
    </>
  )
}

export default function KnowledgeInspectionFiles({
  baseId,
  onOpen
}: {
  baseId: string
  onOpen: (target: InspectionFileTarget) => void
}) {
  const { t } = useTranslation()
  const [path, setPath] = useState<InspectionFile[]>([])
  const [page, setPage] = useState(1)
  const parentId = path.at(-1)?.id
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.files', { baseId, page, parentId }),
    [baseId, page, parentId]
  )
  const query = useInspectionQuery(load)
  const entries = query.data?.items ?? []
  const byId = new Map(entries.map((file) => [file.id, file]))
  const open = (id: string, mode?: FileMode) => {
    const file = byId.get(id)
    if (!file) return
    if (file.directory) {
      setPath((value) => [...value, file])
      setPage(1)
    } else if (file.hasOriginalFile || file.parseStatus === 'ready') {
      onOpen({ file, mode: mode ?? (file.hasOriginalFile ? 'preview' : 'content') })
    }
  }
  return (
    <KnowledgePanelShell
      className="overflow-x-auto"
      headerClassName="shrink-0"
      header={
        path.length ? (
          <div className="flex h-11 items-center justify-between gap-2 border-b border-border">
            {path.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPath((value) => value.slice(0, -1))
                  setPage(1)
                }}>
                <ArrowLeft size={14} />
                {t('knowledge.inspection.back')}
              </Button>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs text-foreground-tertiary">
              {path.map((file) => file.name).join(' / ')}
            </span>
          </div>
        ) : undefined
      }>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('knowledge.inspection.empty_files')}</p>
          ) : null}
          <KnowledgeItemList
            items={entries.map((file) => toRow(baseId, file))}
            isLoading={false}
            hasMore={false}
            isLoadingMore={false}
            onLoadMore={noop}
            selectedIds={noSelection}
            onToggleOne={noop}
            onToggleAll={noop}
            onActivate={(item) => open(item.id)}
            onDelete={noop}
            onPreviewSource={(item) => open(item.id, 'preview')}
            onReindex={noop}
            onViewChunks={(id) => open(id, 'chunks')}
            canActivate={(item) =>
              item.type === 'directory' || item.status === 'completed' || byId.get(item.id)?.hasOriginalFile === true
            }
            canPreviewSource={(item) => byId.get(item.id)?.hasOriginalFile === true}
            selectable={false}
            readOnly
            virtualize={false}
          />
          <div className="shrink-0 px-2.5 py-2">
            <KnowledgeFilePagination
              currentPage={page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              goToPage={setPage}
            />
          </div>
        </>
      ) : null}
    </KnowledgePanelShell>
  )
}
