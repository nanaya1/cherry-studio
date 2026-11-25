// import { ArrowLeft } from 'lucide-react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { CommandPopupMenu } from '@renderer/components/command'
import { FilePreviewLayout, PdfFilePreview } from '@renderer/components/FilePreview'
import { ipcApi } from '@renderer/ipc'
import type {
  OrgKnowledgeBase,
  OrgKnowledgeItem,
  OrgKnowledgeSearchChunk
} from '@shared/data/types/enterpriseKnowledge'
import type { KnowledgeItem, KnowledgeItemOf } from '@shared/data/types/knowledge'
// import { AbsoluteFilePathSchema } from '@shared/types/file'
import type { KnowledgeItemType } from '@shared/data/types/knowledge'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import { useKnowledgeAuthorizationVersion } from '../KnowledgePageProvider'
// 添加菜单直接复用 DataSourcePanel 的公共入口。
import DataSourcePanel from '../panels/dataSource/DataSourcePanel'
import { previewText } from '../utils/sharing'
import { KnowledgeItemSourceDialog } from './AddKnowledgeItemDialog'
import DetailHeader from './DetailHeader'
import { KnowledgeChunkCard, KnowledgeParsedContent } from './KnowledgeDocumentContent'
import KnowledgeFilePagination from './KnowledgeFilePagination'
import KnowledgeSharingPanel from './KnowledgeSharingPanel'
import KnowledgeSourceUpload from './KnowledgeSourceUpload'
import KnowledgeWebButton from './KnowledgeWebButton'
import ShareKnowledgeDialog from './ShareKnowledgeDialog'

// 仅两个入口文件接入内存预览，直接按需加载未由 barrel 导出的 Office 组件。
// eslint-disable-next-line barrel/closed
const WordFilePreview = lazy(() => import('@renderer/components/FilePreview/plugins/word/WordFilePreview'))
const SpreadsheetFilePreview = lazy(
  // eslint-disable-next-line barrel/closed
  () => import('@renderer/components/FilePreview/plugins/spreadsheet/SpreadsheetFilePreview')
)
const PowerPointFilePreview = lazy(
  // eslint-disable-next-line barrel/closed
  () => import('@renderer/components/FilePreview/plugins/powerpoint/PowerPointFilePreview')
)

const logger = loggerService.withContext('OrgKnowledgeDetail')

const toReadOnlyKnowledgeItem = (item: OrgKnowledgeItem): KnowledgeItem =>
  ({
    id: item.id,
    baseId: item.baseId,
    type: item.type === 'directory' ? 'directory' : item.type === 'url' ? 'url' : 'file',
    status: (item.status === 'ready' || item.status === 'completed'
      ? 'completed'
      : item.status === 'failed'
        ? 'failed'
        : 'processing') as KnowledgeItem['status'],
    // error: null,
    error: item.status === 'failed' ? (item.error ?? null) : null,
    groupId: item.parentId,
    createdAt: item.createdAt || new Date(0).toISOString(),
    updatedAt: item.updatedAt || new Date(0).toISOString(),
    data:
      item.type === 'url'
        ? { source: item.title, url: item.title }
        : item.type === 'directory'
          ? { source: item.title }
          : { source: item.title, relativePath: item.title }
  }) as KnowledgeItem

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
        const seen = new Set<string | null>()
        do {
          if (seen.has(nextCursor)) throw new Error(t('common.error'))
          seen.add(nextCursor)
          const page = await ipcApi.request('enterprise.knowledge.items', {
            baseId,
            cursor: nextCursor,
            parentId: null
          })
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
        // value: await ipcApi.request('enterprise.knowledge.preview', { fileId })
        value: await ipcApi.request('enterprise.knowledge.preview', { baseId, fileId })
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
  }, [baseId, target, mode, cursor, t])
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load, useKnowledgeAuthorizationVersion())
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
                  <div key={chunk.id} className="mx-4 my-2">
                    <KnowledgeChunkCard
                      index={chunk.chunkIndex}
                      content={chunk.content}
                      tokenCount={
                        typeof chunk.metadata?.tokenCount === 'number' ? chunk.metadata.tokenCount : undefined
                      }
                    />
                  </div>
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
              {/* 原 PDF 分支仅接收 base64；预览件 URL 与原件内存输入互斥。 */}
              {data.value.kind === 'inline' &&
              (data.value.url || data.value.base64) &&
              data.value.mimeType === 'application/pdf' ? (
                data.value.url ? (
                  <PdfFilePreview fileName={data.value.fileName} url={data.value.url} />
                ) : (
                  <PdfFilePreview fileName={data.value.fileName} base64={data.value.base64!} />
                )
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
              ) : data.value.kind === 'inline' &&
                data.value.base64 &&
                data.value.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? (
                // MEA:enterprise-knowledge-page 原文以内存输入交给现有 Office 查看器。
                <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
                  <WordFilePreview fileName={data.value.fileName} base64={data.value.base64} />
                </Suspense>
              ) : data.value.kind === 'inline' &&
                data.value.base64 &&
                data.value.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? (
                <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
                  <SpreadsheetFilePreview fileName={data.value.fileName} base64={data.value.base64} />
                </Suspense>
              ) : data.value.kind === 'inline' &&
                data.value.base64 &&
                data.value.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ? (
                <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
                  <PowerPointFilePreview fileName={data.value.fileName} base64={data.value.base64} />
                </Suspense>
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
            <KnowledgeParsedContent content={data.value.content} truncated={data.value.truncated} />
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
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load, useKnowledgeAuthorizationVersion())
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

type OrgKnowledgeDetailProps = {
  base: OrgKnowledgeBase
  owned: boolean
  publicLibrary?: boolean
  canManageWeb?: boolean
  onUnshared?: () => void
  onShared?: () => void
}

// MEA:enterprise-knowledge-page 详情自身限定状态归属，直接 rerender 也隔离目录、预览及操作。
export default function OrgKnowledgeDetail(props: OrgKnowledgeDetailProps) {
  // 原 key={props.base.id} 保留；公共库切换会话时需强制重建分页与筛选状态。
  // return <OrgKnowledgeDetailSession key={props.base.id} {...props} />
  const authorizationVersion = useKnowledgeAuthorizationVersion()
  return (
    <OrgKnowledgeDetailSession
      // 权限变化立即销毁旧上传/分享状态，拒绝旧会话回调。
      key={`${props.base.id}-${Boolean(props.publicLibrary)}-${authorizationVersion}-${props.base.editable === true}`}
      {...props}
    />
  )
}

// export default function OrgKnowledgeDetail({
function OrgKnowledgeDetailSession({
  base,
  owned,
  publicLibrary = false,
  canManageWeb = false,
  onUnshared,
  onShared
}: {
  base: OrgKnowledgeBase
  owned: boolean
  publicLibrary?: boolean
  canManageWeb?: boolean
  onUnshared?: () => void
  onShared?: () => void
}) {
  const activeSession = useRef(true)
  useEffect(() => {
    activeSession.current = true
    return () => {
      activeSession.current = false
    }
  }, [])
  // const canCreateShare = owned && Boolean(base.localBaseId) && base.shareCompleted === true
  const canCreateShare = owned
  const editable = base.editable === true
  // const [inviting, setInviting] = useState(false)
  const [sharing, setSharing] = useState<false | 'code' | 'people'>(false)
  const [addSource, setAddSource] = useState<KnowledgeItemType | null>(null)
  const [addFilesInput, setAddFiles] = useState<File[]>()
  const { t } = useTranslation()
  // const [tab, setTab] = useState<'documents' | 'search' | 'members'>('documents')
  // const [tab] = useState<'documents' | 'search' | 'members'>('documents')
  const [tab, setTab] = useState<'documents' | 'search' | 'members'>('documents')
  const [cursor, setCursor] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState<5 | 10 | 20 | 50 | 100>(5)
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'pending' | 'parsing' | 'parsed' | 'indexing' | 'ready' | 'failed'
  >('all')
  const [directoryStack, setDirectoryStack] = useState<OrgKnowledgeItem[]>([])
  const [directoryItems, setDirectoryItems] = useState<OrgKnowledgeItem[] | null>(null)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const directoryRequest = useRef(0)
  useEffect(
    () => () => {
      directoryRequest.current += 1
    },
    [base.id]
  )
  const [target, setTarget] = useState<DocumentTarget | null>(null)
  const [addedBaseId, setAddedBaseId] = useState<string | null>(null)
  const [additionSubmitted, setAdditionSubmitted] = useState(false)
  const [additionMessage, setAdditionMessage] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // const [uploadOriginal, setUploadOriginal] = useState(true)
  const addFiles = async () => {
    setAdding(true)
    setAddError(null)
    try {
      if (!addedBaseId) {
        /* 原单文件选择入口由共用资料添加弹窗承接。
        const files = await window.api.file.select({ properties: ['openFile', 'multiSelections'] })
        // if (!files?.length) return
        if (!activeSession.current || !files?.length) return
        const prepared = await ipcApi.request('enterprise.knowledge.prepare_added_files', { baseId: base.id })
        if (!activeSession.current) return
        setAddedBaseId(prepared.localBaseId)
        await ipcApi.request('knowledge.add_items', {
          baseId: prepared.localBaseId,
          items: files.map((file) => ({
            type: 'file' as const,
            data: { source: file.origin_name || file.name, path: AbsoluteFilePathSchema.parse(file.path) }
          }))
        })
        */
        const prepared = await ipcApi.request('enterprise.knowledge.prepare_added_files', { baseId: base.id })
        if (!activeSession.current) return
        setAddedBaseId(prepared.localBaseId)
      } else {
        const result = await ipcApi.request('enterprise.knowledge.upload_added_files', {
          baseId: base.id,
          localBaseId: addedBaseId
          // uploadOriginal：后续追加由主进程读取服务端策略。
        })
        if (result.completion !== 'completed') throw new Error(t('knowledge.org.upload_incomplete'))
        setAdditionMessage(null)
        setAddedBaseId(null)
        await refresh()
      }
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAdding(false)
    }
  }
  const currentDirectory = directoryStack[directoryStack.length - 1] ?? null
  const currentParentId = currentDirectory?.fileId ?? currentDirectory?.id ?? null
  const load = useCallback(async () => {
    const page = await ipcApi.request('enterprise.knowledge.items', {
      baseId: base.id,
      cursor,
      parentId: currentParentId,
      ...(publicLibrary
        ? { publicLibrary: true, pageSize, statusFilter: statusFilter === 'all' ? null : statusFilter }
        : {})
    })
    return page
  }, [base.id, cursor, currentParentId, publicLibrary, pageSize, statusFilter])
  const {
    data,
    loading,
    error: itemsError,
    refresh
  } = useOrgKnowledgeResource(load, useKnowledgeAuthorizationVersion())
  useEffect(() => {
    if (!addedBaseId || !additionSubmitted) return
    let active = true
    const poll = async () => {
      try {
        const progress = await ipcApi.request('enterprise.knowledge.upload_status', { baseId: addedBaseId })
        if (!active || !progress) return
        setAdditionMessage(
          t(
            progress.phase === 'preparing' || progress.phase === 'counting'
              ? 'knowledge.org.added_local_notice'
              : `knowledge.org.upload_${progress.phase}`
          )
        )
        if (progress.phase === 'paused') {
          setAddError(progress.error)
          setAdditionSubmitted(false)
        } else if (progress.phase === 'completed') {
          setAdditionMessage(null)
          setAddError(null)
          setAdditionSubmitted(false)
          setAddedBaseId(null)
          await refresh()
        }
      } catch (cause) {
        if (active) setAddError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [addedBaseId, additionSubmitted, refresh, t])
  // MEA:public-knowledge-ready-pagination 数据减少导致请求页为空时回首页，避免停在空白页。
  useEffect(() => {
    if (publicLibrary && !loading && data && cursor && data.items.length === 0) {
      setCursor(null)
    }
  }, [publicLibrary, loading, data, cursor])
  const currentPage = cursor ? Number(cursor) : 1
  const goToPage = (page: number) => setCursor(page === 1 ? null : String(page))
  const visibleItems = useMemo(() => directoryItems ?? data?.items ?? [], [data?.items, directoryItems])
  const readOnlyItems = useMemo(() => visibleItems.map(toReadOnlyKnowledgeItem), [visibleItems])
  const enterDirectory = useCallback(
    async (item: OrgKnowledgeItem) => {
      const request = ++directoryRequest.current
      setTarget(null)
      setCursor(null)
      setDirectoryError(null)
      setDirectoryItems(null)
      setDirectoryStack((previous) => [...previous, item])
      // MEA:public-knowledge-ready-pagination 公共浏览只请求当前页，管理目录保留全量批操作。
      if (publicLibrary) return
      try {
        const items: OrgKnowledgeItem[] = []
        const seen = new Set<string | null>()
        let nextCursor: string | null = null
        do {
          if (seen.has(nextCursor)) throw new Error(t('common.error'))
          seen.add(nextCursor)
          const page = await ipcApi.request('enterprise.knowledge.items', {
            baseId: base.id,
            cursor: nextCursor,
            parentId: item.fileId ?? item.id
          })
          if (request !== directoryRequest.current) return
          items.push(...page.items)
          nextCursor = page.nextCursor
        } while (nextCursor)
        setDirectoryItems(items)
      } catch (cause) {
        if (request !== directoryRequest.current) return
        setDirectoryError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [base.id, publicLibrary, t]
  )
  const navigateUp = useCallback(() => {
    directoryRequest.current += 1
    setDirectoryError(null)
    setTarget(null)
    setCursor(null)
    // setDirectoryStack((previous) => {
    //   const next = previous.slice(0, -1)
    //   if (next.length === 0) setDirectoryItems(null)
    //   return next
    // })
    // MEA: 每次返回上级都清空旧目录列表，避免子目录缓存遮住父目录查询结果。
    setDirectoryItems(null)
    setDirectoryStack((previous) => previous.slice(0, -1))
  }, [])
  const openRemoteItem = useCallback(
    (item: KnowledgeItem, mode?: 'preview' | 'chunks') => {
      const remote = visibleItems.find((entry) => entry.id === item.id)
      if (!remote) return
      if (remote.type === 'directory') {
        void enterDirectory(remote)
        return
      }
      if (remote.documentId) {
        setTarget({
          itemId: remote.id,
          documentId: remote.documentId,
          fileId: remote.fileId ?? undefined,
          title: remote.title,
          mode: mode ?? (remote.type === 'file' && remote.hasOriginalFile ? 'preview' : 'chunks')
        })
      }
    },
    [enterDirectory, visibleItems]
  )
  const previewRemoteItem = useCallback((item: KnowledgeItem) => openRemoteItem(item, 'preview'), [openRemoteItem])
  // 旧服务端兼容标记对应知识管理员，不能显示为预留的空间管理员。
  const role = base.knowledgeRole ?? (base.spaceAdministrator ? 2 : undefined)
  const roleLabel =
    role === 1
      ? t('knowledge.org.space_administrator')
      : role === 2
        ? t('knowledge.org.knowledge_manager')
        : role === 3
          ? t('knowledge.org.knowledge_member')
          : undefined
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
      <DetailHeader
        base={base}
        sharingStatus={
          // base.spaceAdministrator ? (<Badge variant="outline">{t('knowledge.org.space_administrator')}</Badge>) : undefined
          roleLabel ? <Badge variant="outline">{roleLabel}</Badge> : undefined
        }
        // action={<Badge variant="outline">{t('knowledge.org.readonly')}</Badge>}
        actions={
          <>
            {canManageWeb ? <KnowledgeWebButton baseId={base.id} /> : null}
            {owned ? (
              <>
                <Button variant="ghost" onClick={() => setTab(tab === 'members' ? 'documents' : 'members')}>
                  {t(tab === 'members' ? 'knowledge.org.documents' : 'knowledge.org.shares')}
                </Button>
                {/* 原独立邀请按钮由与本地一致的分享菜单承接。 */}
                {canCreateShare ? (
                  <CommandPopupMenu
                    location="webcontents.context"
                    align="end"
                    side="bottom"
                    extraItems={[
                      {
                        type: 'item',
                        id: 'share-code',
                        label: t('knowledge.org.share_code'),
                        onSelect: () => setSharing('code')
                      },
                      {
                        type: 'item',
                        id: 'invite-people',
                        label: t('knowledge.org.invite_people'),
                        onSelect: () => setSharing('people')
                      }
                    ]}>
                    <Button variant="ghost" size="sm">
                      {t('knowledge.org.share')}
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </CommandPopupMenu>
                ) : null}
              </>
            ) : null}
          </>
        }
      />
      {/* 原邀请入口依赖 base.localBaseId；已有云端库直接使用云端身份。 */}
      {sharing && canCreateShare ? (
        <ShareKnowledgeDialog
          baseId={base.id}
          name={base.name}
          remote
          mode={sharing}
          onClose={() => setSharing(false)}
          onShared={() => onShared?.()}
        />
      ) : null}
      {addSource && addedBaseId && owned ? (
        <KnowledgeItemSourceDialog
          open
          selectedBaseId={addedBaseId}
          cloudBaseId={base.id}
          pendingAddSource={addSource}
          pendingAddFiles={addFilesInput}
          onAdded={() => {
            setAdditionSubmitted(true)
            setAdditionMessage(t('knowledge.org.added_local_notice'))
            setAddError(null)
          }}
          onOpenChange={(open) => {
            if (!open) setAddSource(null)
          }}
        />
      ) : null}
      {owned ? (
        <div className="px-6 py-2 text-sm">
          {/* 首次共享已确定策略，追加不再允许选择。
          <label className="flex items-start gap-2">
            <Checkbox
              checked={uploadOriginal}
              disabled={adding || !!addedBaseId}
              onCheckedChange={(checked) => setUploadOriginal(checked === true)}
            />
            {t('knowledge.org.upload_original_notice')}
          </label>
          */}
          {/* {addedBaseId ? <p role="status">{t('knowledge.org.added_local_notice')}</p> : null} */}
          {additionMessage ? <p role="status">{additionMessage}</p> : null}
          {addError ? <p role="alert">{addError}</p> : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden px-3 pt-3 pb-4">
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
          <KnowledgeSharingPanel
            key={base.id}
            baseId={base.id}
            name={base.name}
            localBaseId={base.localBaseId}
            canCreateShare={canCreateShare}
            onUnshared={onUnshared}
          />
        ) : tab === 'search' ? (
          <SearchPanel baseId={base.id} onOpen={setTarget} />
        ) : (
          <>
            {itemsError ? (
              <div role="alert" className="px-3 pb-2 text-error text-sm">
                <p>{itemsError}</p>
                <Button onClick={() => void refresh()}>{t('knowledge.org.refresh')}</Button>
              </div>
            ) : null}
            {directoryError ? (
              <p role="alert" className="px-3 pb-2 text-error text-sm">
                {directoryError}
              </p>
            ) : null}
            <DataSourcePanel
              items={readOnlyItems}
              total={data?.total ?? base.documentCount ?? 0}
              isLoading={loading}
              // hasMore={Boolean(data?.nextCursor)}
              hasMore={!publicLibrary && Boolean(data?.nextCursor)}
              isLoadingMore={false}
              onLoadMore={() => setCursor(data?.nextCursor ?? null)}
              updatedAt={base.updatedAt ?? ''}
              // onAdd={() => {}}
              // allowAdd={owned && !adding}
              // MEA:public-knowledge-status-filter 公共库内容维护单独依赖服务端editable。
              // allowAdd={owned && !publicLibrary && !adding}
              allowAdd={editable && owned && !publicLibrary && !adding}
              onAdd={(source = 'file', files) => {
                // if (adding || !owned) return
                if (adding || !owned || !editable) return
                const open = (localBaseId: string) => {
                  if (!activeSession.current) return
                  setAddedBaseId(localBaseId)
                  setAddSource(source)
                  setAddFiles(files)
                }
                if (addedBaseId) {
                  open(addedBaseId)
                  return
                }
                setAdding(true)
                setAddError(null)
                void ipcApi
                  .request('enterprise.knowledge.prepare_added_files', { baseId: base.id })
                  .then((prepared) => open(prepared.localBaseId))
                  .catch((cause) => {
                    if (activeSession.current) setAddError(cause instanceof Error ? cause.message : String(cause))
                  })
                  .finally(() => {
                    if (activeSession.current) setAdding(false)
                  })
              }}
              onPreviewFile={() => {}}
              onActivateItem={(item) => openRemoteItem(item)}
              onPreviewSource={previewRemoteItem}
              onItemClick={(itemId) => {
                const item = readOnlyItems.find((entry) => entry.id === itemId)
                if (item) openRemoteItem(item, 'chunks')
              }}
              onDrillIntoDirectory={(item) => {
                const remote = visibleItems.find((entry) => entry.id === item.id)
                if (remote) void enterDirectory(remote)
              }}
              currentDirectory={
                currentDirectory ? (toReadOnlyKnowledgeItem(currentDirectory) as KnowledgeItemOf<'directory'>) : null
              }
              onNavigateUp={navigateUp}
              // onDelete={() => {}}
              onDelete={async (item) => {
                const remote = visibleItems.find((entry) => entry.id === item.id)
                // if (!owned || !remote?.fileId) throw new Error(t('common.error'))
                if (!editable || !remote?.fileId) throw new Error(t('common.error'))
                await ipcApi.request('enterprise.knowledge.delete_file', { baseId: base.id, fileId: remote.fileId })
                if (!activeSession.current) return
                // if (currentDirectory) {
                // MEA:public-knowledge-ready-pagination 公共目录不遍历全量，删除后只刷新当前页。
                if (currentDirectory && !publicLibrary) {
                  const request = ++directoryRequest.current
                  const items: OrgKnowledgeItem[] = []
                  const seen = new Set<string | null>()
                  let nextCursor: string | null = null
                  do {
                    if (seen.has(nextCursor)) throw new Error(t('common.error'))
                    seen.add(nextCursor)
                    const page = await ipcApi.request('enterprise.knowledge.items', {
                      baseId: base.id,
                      cursor: nextCursor,
                      parentId: currentParentId
                    })
                    if (request !== directoryRequest.current || !activeSession.current) return
                    items.push(...page.items)
                    nextCursor = page.nextCursor
                  } while (nextCursor)
                  setDirectoryItems(items)
                }
                await refresh()
                onShared?.()
              }}
              // allowDelete={(item) => owned && Boolean(visibleItems.find((entry) => entry.id === item.id)?.fileId)}
              allowDelete={(item) => editable && Boolean(visibleItems.find((entry) => entry.id === item.id)?.fileId)}
              deleteDescription={t('knowledge.org.delete_file_notice')}
              onDeleteItems={async (itemIds) => {
                if (!editable) throw new Error(t('common.error'))
                const selectedFiles = itemIds.map((itemId) => {
                  const remote = visibleItems.find((entry) => entry.id === itemId)
                  if (!remote?.fileId) throw new Error(t('common.error'))
                  return remote.fileId
                })
                let firstError: unknown
                for (const fileId of selectedFiles) {
                  try {
                    await ipcApi.request('enterprise.knowledge.delete_file', { baseId: base.id, fileId })
                  } catch (cause) {
                    firstError ??= cause
                  }
                }
                if (!activeSession.current) {
                  if (firstError) throw firstError
                  return
                }
                // if (currentDirectory) {
                // MEA:public-knowledge-ready-pagination 公共目录不遍历全量，删除后只刷新当前页。
                if (currentDirectory && !publicLibrary) {
                  const request = ++directoryRequest.current
                  const items: OrgKnowledgeItem[] = []
                  const seen = new Set<string | null>()
                  let nextCursor: string | null = null
                  do {
                    if (seen.has(nextCursor)) throw new Error(t('common.error'))
                    seen.add(nextCursor)
                    const page = await ipcApi.request('enterprise.knowledge.items', {
                      baseId: base.id,
                      cursor: nextCursor,
                      parentId: currentParentId
                    })
                    if (request !== directoryRequest.current || !activeSession.current) return
                    items.push(...page.items)
                    nextCursor = page.nextCursor
                  } while (nextCursor)
                  setDirectoryItems(items)
                }
                await refresh()
                onShared?.()
                if (firstError) throw firstError
              }}
              onReindex={() => {}}
              onReindexItems={() => {}}
              readOnly
              virtualize={false}
              paginationActions={
                publicLibrary ? (
                  <KnowledgeFilePagination
                    total={data?.total ?? 0}
                    pageSize={pageSize}
                    currentPage={currentPage}
                    goToPage={goToPage}
                    loading={loading}
                    hasNext={Boolean(data?.nextCursor)}
                    onPageSizeChange={(size) => {
                      setPageSize(size as 5 | 10 | 20 | 50 | 100)
                      setCursor(null)
                    }}
                  />
                ) : data?.nextCursor ? (
                  <Button variant="outline" size="sm" onClick={() => setCursor(data.nextCursor)}>
                    {t('knowledge.org.next_page')}
                  </Button>
                ) : undefined
              }
              toolbarActions={
                <>
                  {editable && (!owned || publicLibrary) ? (
                    <KnowledgeSourceUpload
                      key={`${base.id}-${currentParentId}`}
                      baseId={base.id}
                      parentId={currentParentId}
                      onChanged={async () => {
                        setDirectoryItems(null)
                        await refresh()
                        onShared?.()
                      }}
                    />
                  ) : null}
                  {publicLibrary ? (
                    <Select
                      value={statusFilter}
                      disabled={loading}
                      onValueChange={(value) => {
                        setStatusFilter(value as typeof statusFilter)
                        setCursor(null)
                      }}>
                      <SelectTrigger
                        size="sm"
                        aria-label={t('knowledge.org.status_filter')}
                        className="h-7 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value="all">{t('common.all')}</SelectItem>
                        <SelectItem value="pending">{t('knowledge.org.status.pending')}</SelectItem>
                        <SelectItem value="parsing">{t('knowledge.org.status.parsing')}</SelectItem>
                        <SelectItem value="parsed">{t('knowledge.org.status.parsed')}</SelectItem>
                        <SelectItem value="indexing">{t('knowledge.org.status.indexing')}</SelectItem>
                        <SelectItem value="ready">{t('knowledge.org.status.ready')}</SelectItem>
                        <SelectItem value="failed">{t('knowledge.org.status.failed')}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : owned && editable && (!currentDirectory || addedBaseId) ? (
                    <>
                      {addedBaseId && addError && !additionSubmitted ? (
                        <Button variant="outline" size="sm" disabled={adding} onClick={() => void addFiles()}>
                          {t('knowledge.org.upload_continue')}
                        </Button>
                      ) : null}
                      {/* 添加菜单由共用面板提供，继续上传保留独立操作。 */}
                    </>
                  ) : null}
                </>
              }
            />
          </>
        )}
      </div>
    </main>
  )
}
