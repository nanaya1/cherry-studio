import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@cherrystudio/ui'
import { DIALOG_UNMOUNT_DELAY_MS } from '@cherrystudio/ui/utils'
import { ipcApi } from '@renderer/ipc'
import { loggerService } from '@renderer/services/LoggerService'
import { openRoute } from '@renderer/services/mainWindowNavigation'
import { cn } from '@renderer/utils/style'
import { getSkillDescription, getSkillDisplayName } from '@shared/data/api/schemas/skills'
import type { InstalledSkill } from '@shared/data/types/agent'
import { Play, Trash2 } from 'lucide-react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SkillFileBrowser } from './SkillFileBrowser'

interface Props {
  skill: InstalledSkill | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete?: () => void
}

const logger = loggerService.withContext('SkillDetailDialog')
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

function formatDate(dateStr: string, language: string): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function getSkillInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function getFallbackStyle(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return FALLBACK_STYLES[hash % FALLBACK_STYLES.length]
}

const SkillDetailDialog: FC<Props> = ({ skill, open, onOpenChange, onDelete }) => {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language
  const [dialogOpen, setDialogOpen] = useState(open)
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [iconFailed, setIconFailed] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  useEffect(() => {
    clearCloseTimer()
    setDialogOpen(open)
  }, [clearCloseTimer, open, skill?.id])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  useEffect(() => {
    let cancelled = false
    setIconUrl(null)
    setIconFailed(false)
    if (!skill?.iconFileName) return

    void ipcApi
      .request('skill.icons.resolve', { skillIds: [skill.id] })
      .then((urls) => {
        if (!cancelled) setIconUrl(urls[skill.id] ?? null)
      })
      .catch((error) => {
        if (!cancelled) setIconFailed(true)
        logger.warn('Failed to resolve skill icon', { skillId: skill.id, error })
      })

    return () => {
      cancelled = true
    }
  }, [skill?.iconFileName, skill?.id])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      clearCloseTimer()
      setDialogOpen(nextOpen)
      if (nextOpen) {
        onOpenChange(true)
        return
      }
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        onOpenChange(false)
      }, DIALOG_UNMOUNT_DELAY_MS)
    },
    [clearCloseTimer, onOpenChange]
  )

  const handleTry = () => {
    if (!skill) return
    openRoute('/app/new-task', { mode: 'agent', skillId: skill.id })
    handleOpenChange(false)
  }

  if (!skill) return null

  const displayName = getSkillDisplayName(skill, locale)
  const description = getSkillDescription(skill, locale)

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="flex max-h-[min(720px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 px-7 pt-7 pb-6">
          <DialogHeader className="pr-8 text-left">
            <div className="flex min-w-0 items-start gap-4">
              <Avatar className="size-14 shrink-0 rounded-lg">
                {iconUrl && !iconFailed ? (
                  <AvatarImage
                    src={iconUrl}
                    alt=""
                    draggable={false}
                    className="rounded-lg object-cover"
                    onError={() => setIconFailed(true)}
                  />
                ) : null}
                <AvatarFallback className={cn('rounded-lg font-semibold text-xl', getFallbackStyle(displayName))}>
                  {getSkillInitial(displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 pt-0.5">
                <DialogTitle className="truncate text-xl leading-7">{displayName}</DialogTitle>
                <p className="mt-1.5 line-clamp-2 text-muted-foreground text-sm leading-5">
                  {description || t('library.skill_detail.no_description')}
                </p>
              </div>
            </div>
          </DialogHeader>

          <dl className="mt-5 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-foreground-tertiary">{t('workspace.skill_catalog.version')}</dt>
              <dd className="mt-1 text-foreground">{skill.version?.trim() || '-'}</dd>
            </div>
            <div>
              <dt className="text-foreground-tertiary">{t('library.skill_detail.created_at')}</dt>
              <dd className="mt-1 text-foreground">{formatDate(skill.createdAt, locale)}</dd>
            </div>
            <div>
              <dt className="text-foreground-tertiary">{t('library.skill_detail.updated_at')}</dt>
              <dd className="mt-1 text-foreground">{formatDate(skill.updatedAt, locale)}</dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={handleTry}>
              <Play className="size-3.5" />
              {t('library.skill_detail.try')}
            </Button>
            {onDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onDelete}
                className="border border-destructive/50 text-destructive hover:border-destructive hover:bg-error-subtle hover:text-destructive">
                <Trash2 className="size-3.5" />
                {t('common.delete')}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 border-border-subtle border-t bg-background-subtle/40">
          <SkillFileBrowser skillId={skill.id} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SkillDetailDialog
