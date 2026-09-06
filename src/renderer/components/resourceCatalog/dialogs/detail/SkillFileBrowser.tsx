import { loggerService } from '@renderer/services/LoggerService'
import DOMPurify from 'dompurify'
import { FileText, Loader2 } from 'lucide-react'
import MarkdownIt from 'markdown-it'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('SkillFileBrowser')
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true })

// Render YAML frontmatter as plain text lines instead of headings/hr
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function renderSkillMarkdown(source: string): string {
  const match = source.match(FRONTMATTER_RE)
  if (!match) {
    return markdown.render(source)
  }
  const [, frontmatter] = match
  const body = source.slice(match[0].length)
  return markdown.render(frontmatter) + markdown.render(body)
}

interface Props {
  skillId: string
}

export function SkillFileBrowser({ skillId }: Props) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const renderedContent = useMemo(
    () => (content === null ? '' : DOMPurify.sanitize(renderSkillMarkdown(content))),
    [content]
  )

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setFailed(false)
    setLoading(true)

    void window.api.skill
      .readSkillFile(skillId, 'SKILL.md')
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          logger.warn('Failed to load SKILL.md', { skillId, error: result.error })
          setFailed(true)
          return
        }
        if (result.data === null) {
          logger.warn('SKILL.md content is unavailable', { skillId })
          setFailed(true)
          return
        }
        setContent(result.data)
      })
      .catch((error) => {
        if (cancelled) return
        logger.warn('Failed to load SKILL.md', { skillId, error })
        setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [skillId])

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-border-subtle border-b px-5">
        <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="font-medium text-sm">{t('library.skill_detail.overview')}</h3>
      </div>
      <div className="min-h-64 flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div role="status" className="flex min-h-64 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : failed || content === null ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-foreground-tertiary">
            <FileText className="size-7" strokeWidth={1.2} aria-hidden="true" />
            <span className="text-sm">{t('library.skill_detail.file_load_failed')}</span>
          </div>
        ) : (
          <div
            className="mx-auto w-full max-w-3xl space-y-3 text-foreground text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-border [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_em]:italic [&_h1]:font-semibold [&_h1]:text-base [&_h1]:text-foreground [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:text-sm [&_hr]:border-border [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_p]:whitespace-normal [&_strong]:font-semibold [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
        )}
      </div>
    </section>
  )
}
