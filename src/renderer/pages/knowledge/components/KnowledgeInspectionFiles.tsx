import { FileText, Folder, ArrowLeft } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { InspectionFile } from '@shared/data/types/knowledgeInspection'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import InspectionPager from './InspectionPager'
import InspectionQueryState from './InspectionQueryState'

const statusKeys: Record<string, string> = {
  ready: 'knowledge.inspection.status.ready',
  pending: 'knowledge.inspection.status.pending',
  parsing: 'knowledge.inspection.status.parsing',
  parsed: 'knowledge.inspection.status.parsed',
  indexing: 'knowledge.inspection.status.indexing',
  failed: 'knowledge.inspection.status.failed'
}

function PublishedFile({ baseId, file, onBack }: { baseId: string; file: InspectionFile; onBack: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'content' | 'chunks'>('content')
  const [page, setPage] = useState(1)
  const loadContent = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.content', { baseId, fileId: file.id }),
    [baseId, file.id]
  )
  return (
    <section className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('knowledge.inspection.back_files')}
      </Button>
      <h3 className="break-all text-lg font-medium">{file.name}</h3>
      <div className="flex gap-2">
        {(['content', 'chunks'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}>
            {t(value === 'content' ? 'knowledge.inspection.content' : 'knowledge.inspection.chunks')}
          </Button>
        ))}
      </div>
      {mode === 'content' ? (
        <InspectionContent load={loadContent} />
      ) : (
        <InspectionChunks baseId={baseId} fileId={file.id} page={page} onPage={setPage} />
      )}
    </section>
  )
}

function InspectionContent({
  load
}: {
  load: () => ReturnType<typeof ipcApi.request<'enterprise.knowledge.inspection.content'>>
}) {
  const { t } = useTranslation()
  const query = useInspectionQuery(load)
  return (
    <>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t('knowledge.inspection.content_length', { count: query.data.totalChars ?? query.data.content.length })}
          </p>
          {query.data.truncated ? (
            <p className="text-sm text-muted-foreground">{t('knowledge.inspection.truncated')}</p>
          ) : null}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{query.data.content}</pre>
        </>
      ) : null}
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
  const { t } = useTranslation()
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
            <article key={chunk.id} className="space-y-2 rounded-lg border border-border p-4">
              <h4 className="text-xs text-muted-foreground">
                {t('knowledge.inspection.chunk_number', { number: chunk.chunkIndex + 1 })}
              </h4>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{chunk.content}</pre>
            </article>
          ))}
          <InspectionPager page={page} total={query.data.total} onChange={onPage} />
        </>
      ) : null}
    </>
  )
}

export default function KnowledgeInspectionFiles({ baseId }: { baseId: string }) {
  const { t } = useTranslation()
  const [path, setPath] = useState<InspectionFile[]>([])
  const [page, setPage] = useState(1)
  const [opened, setOpened] = useState<InspectionFile | null>(null)
  const parentId = path.at(-1)?.id
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.files', { baseId, page, parentId }),
    [baseId, page, parentId]
  )
  const query = useInspectionQuery(load)
  if (opened) return <PublishedFile key={opened.id} baseId={baseId} file={opened} onBack={() => setOpened(null)} />
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="break-all text-sm text-muted-foreground">
          {[t('knowledge.inspection.files'), ...path.map((file) => file.name)].join(' / ')}
        </span>
        <Button variant="ghost" size="sm" onClick={query.reload}>
          {t('knowledge.org.refresh')}
        </Button>
      </div>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('knowledge.inspection.empty_files')}</p>
          ) : null}
          <div className="divide-y divide-border">
            {query.data.items.map((file) => (
              <div key={file.id} className="flex flex-wrap items-center gap-3 py-3">
                {file.directory ? (
                  <Folder size={18} className="shrink-0 text-muted-foreground" />
                ) : (
                  <FileText size={18} className="shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm">{file.name}</p>
                  {!file.directory ? (
                    <span className="text-xs text-muted-foreground">
                      {t(statusKeys[file.parseStatus ?? ''] ?? 'knowledge.inspection.unknown')}
                    </span>
                  ) : null}
                </div>
                {file.directory ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPath((value) => [...value, file])
                      setPage(1)
                    }}>
                    {t('knowledge.inspection.open')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={file.parseStatus !== 'ready'}
                    onClick={() => setOpened(file)}>
                    {t('knowledge.inspection.view')}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <InspectionPager page={page} total={query.data.total} onChange={setPage} />
        </>
      ) : null}
    </section>
  )
}
