import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, Input, PageHeader } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { OrgKnowledgeBase, OrgKnowledgeSearchChunk } from '@shared/data/types/enterpriseKnowledge'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import { previewText } from '../utils/sharing'
import KnowledgeSharingPanel from './KnowledgeSharingPanel'

type DocumentTarget = { itemId?: string; documentId: string; fileId?: string; chunkId?: string; title: string }

function DocumentView({ baseId, target, onBack }: { baseId: string; target: DocumentTarget; onBack: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'read' | 'chunks' | 'preview'>('read')
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
    <section className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>
        <h2 className="min-w-0 flex-1 break-words font-medium">{target.title}</h2>
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
      </div>
      {loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : error ? (
        <div role="alert">
          <p className="text-error">{error}</p>
          <Button onClick={() => void refresh()}>{t('knowledge.org.refresh')}</Button>
        </div>
      ) : data?.mode === 'chunks' ? (
        <>
          <p className="text-sm text-muted-foreground">{t('knowledge.org.chunk_total', { count: data.value.total })}</p>
          {data.value.chunks.length === 0 ? (
            <p>{t('knowledge.org.empty_chunks')}</p>
          ) : (
            data.value.chunks.map((chunk) => (
              <article key={chunk.id} className="rounded border border-border p-3">
                <p className="text-sm text-muted-foreground">{chunk.chunkIndex + 1}</p>
                <p className="whitespace-pre-wrap break-words">{chunk.content}</p>
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
          <p className="font-medium">{data.value.fileName}</p>
          {data.value.kind === 'inline' && data.value.base64 && data.value.mimeType === 'application/pdf' ? (
            <iframe
              title={data.value.fileName}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-[70vh] w-full"
              src={`data:application/pdf;base64,${data.value.base64}`}
            />
          ) : data.value.kind === 'inline' &&
            data.value.base64 &&
            ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(
              data.value.mimeType ?? ''
            ) ? (
            <img
              alt={data.value.fileName}
              className="max-w-full"
              src={`data:${data.value.mimeType};base64,${data.value.base64}`}
            />
          ) : previewText(data.value) === null ? (
            <p role="status" className="text-muted-foreground">
              {t('knowledge.org.preview_unavailable')}
            </p>
          ) : (
            <article className="whitespace-pre-wrap break-words">
              {previewText(data.value) || t('knowledge.org.empty_content')}
            </article>
          )}
        </>
      ) : data?.mode === 'read' ? (
        <>
          <article className="whitespace-pre-wrap break-words">
            {data.value.content || t('knowledge.org.empty_content')}
          </article>
          {data.value.truncated ? <p className="text-warning">{t('knowledge.org.truncated')}</p> : null}
        </>
      ) : null}
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
  const { t } = useTranslation()
  const [tab, setTab] = useState<'documents' | 'search' | 'members'>('documents')
  const [cursor, setCursor] = useState<string | null>(null)
  const [target, setTarget] = useState<DocumentTarget | null>(null)
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.items', { baseId: base.id, cursor }),
    [base.id, cursor]
  )
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  return (
    <main data-ui="knowledge.content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        className="h-auto min-h-20 border-b border-border px-6 py-5 [&_h1]:text-xl"
        title={base.name}
        action={<Badge variant="outline">{t('knowledge.org.readonly')}</Badge>}
      />
      <div className="min-h-0 flex-1 overflow-auto">
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
        {target ? (
          <DocumentView
            key={`${target.documentId}-${target.chunkId ?? ''}`}
            baseId={base.id}
            target={target}
            onBack={() => setTarget(null)}
          />
        ) : tab === 'members' && owned ? (
          <KnowledgeSharingPanel key={base.id} baseId={base.id} name={base.name} />
        ) : tab === 'search' ? (
          <SearchPanel baseId={base.id} onOpen={setTarget} />
        ) : (
          <section className="space-y-3 px-6 py-5" aria-label={t('knowledge.org.documents')}>
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
