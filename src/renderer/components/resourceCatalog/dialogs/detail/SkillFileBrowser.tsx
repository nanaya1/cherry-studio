import { Markdown } from '@cherrystudio/ui'
import { loggerService } from '@renderer/services/LoggerService'
import { FileText, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('SkillFileBrowser')

interface Props {
  skillId: string
}

export function SkillFileBrowser({ skillId }: Props) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

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
        <h3 className="font-medium text-sm">SKILL.md</h3>
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
          <Markdown id={`${skillId}:SKILL.md`} footnoteLabel={t('common.footnotes')}>
            {content}
          </Markdown>
        )}
      </div>
    </section>
  )
}
