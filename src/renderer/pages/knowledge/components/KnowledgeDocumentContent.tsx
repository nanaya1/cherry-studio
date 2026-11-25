import { useTranslation } from 'react-i18next'

export function KnowledgeParsedContent({ content, truncated }: { content: string; truncated?: boolean }) {
  const { t } = useTranslation()
  return (
    <>
      <article className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">
        {content || t('knowledge.org.empty_content')}
      </article>
      {truncated ? <p className="px-4 pb-3 text-sm text-warning">{t('knowledge.org.truncated')}</p> : null}
    </>
  )
}

export function KnowledgeChunkCard({
  index,
  content,
  tokenCount,
  fullText = false
}: {
  index: number
  content: string
  tokenCount?: number
  fullText?: boolean
}) {
  const { t } = useTranslation()
  return (
    <article className="rounded-lg border border-border-subtle transition-colors hover:border-border-strong">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-accent text-xs leading-4 text-foreground-tertiary">
          {index + 1}
        </span>
        {typeof tokenCount === 'number' ? (
          <span className="text-xs text-foreground-tertiary">
            {tokenCount} {t('knowledge.rag.tokens_unit')}
          </span>
        ) : null}
      </div>
      <div className="px-3 pb-3">
        <p
          className={`text-sm leading-relaxed text-muted-foreground ${fullText ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'}`}>
          {content}
        </p>
      </div>
    </article>
  )
}
