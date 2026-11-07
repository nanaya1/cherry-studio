import { ChevronLeft, ChevronRight, Database, FileText, Folder } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { useInfiniteQuery } from '@data/hooks/useDataApi'
import { getKnowledgeItemDisplayTitle, type KnowledgeItemOf } from '@shared/data/types/knowledge'

function KnowledgeFiles({
  baseId,
  disabled,
  onSelect
}: {
  baseId: string
  disabled: boolean
  onSelect: (id: string, name: string) => void
}) {
  const { t } = useTranslation()
  const [directoryStack, setDirectoryStack] = useState<KnowledgeItemOf<'directory'>[]>([])
  const currentDirectory = directoryStack.at(-1)
  const { pages, error, isLoading, hasNext, loadNext } = useInfiniteQuery('/knowledge-bases/:id/items', {
    params: { id: baseId },
    query: { groupId: currentDirectory?.id ?? null }
  })
  const items = pages.flatMap((page) => page.items).filter((item) => item.type === 'file' || item.type === 'directory')
  return (
    <div className="flex min-h-64 flex-col">
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error.message}
        </p>
      )}
      {isLoading && (
        <p role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t('industrial_video.loading')}
        </p>
      )}
      {currentDirectory && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 font-normal text-muted-foreground"
            onClick={() => setDirectoryStack((stack) => stack.slice(0, -1))}>
            <ChevronLeft className="size-4" />
            {t('knowledge.data_source.back_to_parent')}
          </Button>
          <span
            className="min-w-0 truncate text-sm text-muted-foreground"
            title={getKnowledgeItemDisplayTitle(currentDirectory)}>
            {getKnowledgeItemDisplayTitle(currentDirectory)}
          </span>
        </div>
      )}
      {!isLoading && !error && !items.length && (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {currentDirectory ? t('knowledge.data_source.empty_folder') : t('industrial_video.no_files')}
        </p>
      )}
      <div className="flex max-h-80 flex-col overflow-y-auto p-2">
        {items.map((item) => {
          const title = getKnowledgeItemDisplayTitle(item)
          const isDirectory = item.type === 'directory'
          return (
            <Button
              key={item.id}
              variant="ghost"
              disabled={disabled}
              className="h-10 w-full justify-start gap-2 px-3 font-normal"
              title={title}
              onClick={() => {
                if (isDirectory) {
                  setDirectoryStack((stack) => [...stack, item])
                  return
                }
                onSelect(item.id, title)
              }}>
              {isDirectory ? (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{title}</span>
              {isDirectory && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            </Button>
          )
        })}
      </div>
      {hasNext && (
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={isLoading}
            onClick={() => {
              // MEA:industrial-video loadNext 同步返回 void，不忽略不存在的返回值。
              // void loadNext()
              loadNext()
            }}>
            {t('industrial_video.load_more')}
          </Button>
        </div>
      )}
    </div>
  )
}

export default function IndustrialVideoKnowledgePicker({
  disabled,
  onSelect
}: {
  disabled: boolean
  onSelect: (id: string, name: string) => void
}) {
  const { t } = useTranslation()
  const [baseId, setBaseId] = useState('')
  const { pages, error, isLoading, hasNext, loadNext } = useInfiniteQuery('/knowledge-bases')
  const items = pages.flatMap((page) => page.items)
  return (
    <section
      aria-label={t('industrial_video.local_knowledge')}
      className="min-h-64 overflow-hidden rounded-lg border bg-background">
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error.message}
        </p>
      )}
      {isLoading && (
        <p role="status" className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          {t('industrial_video.loading')}
        </p>
      )}
      {!isLoading && !error && !items.length && (
        <p className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          {t('industrial_video.no_knowledge_bases')}
        </p>
      )}
      {!isLoading && !error && items.length > 0 && (
        <div className="grid min-h-64 grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="flex max-h-80 flex-col overflow-y-auto border-b bg-muted/30 p-2 sm:border-r sm:border-b-0">
            {items.map((base) => {
              const selected = base.id === baseId
              return (
                <Button
                  key={base.id}
                  variant="ghost"
                  disabled={disabled}
                  aria-pressed={selected}
                  title={base.name}
                  className={`h-10 w-full justify-start gap-2 px-3 font-normal ${
                    selected ? 'bg-accent text-accent-foreground hover:bg-accent' : ''
                  }`}
                  onClick={() => setBaseId(base.id)}>
                  <Database className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{base.name}</span>
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-muted-foreground ${selected ? 'opacity-100' : 'opacity-0'}`}
                  />
                </Button>
              )
            })}
            {hasNext && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full"
                disabled={isLoading}
                onClick={() => {
                  // MEA:industrial-video loadNext 同步返回 void，不忽略不存在的返回值。
                  // void loadNext()
                  loadNext()
                }}>
                {t('industrial_video.load_more')}
              </Button>
            )}
          </div>
          <div className="min-w-0">
            {baseId ? (
              <KnowledgeFiles key={baseId} baseId={baseId} disabled={disabled} onSelect={onSelect} />
            ) : (
              <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('chat.save.knowledge.select.base.placeholder')}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
