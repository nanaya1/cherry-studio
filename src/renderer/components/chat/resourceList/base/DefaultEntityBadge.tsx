import { cn } from '@renderer/utils/style'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The "默认" pill rendered next to the builtin assistant / agent name. Purely
 * informational — the not-deletable guarantee lives in the main-process services.
 */
export function DefaultEntityBadge({ className }: { className?: string }): ReactNode {
  const { t } = useTranslation()

  return (
    <span
      className={cn(
        'shrink-0 rounded-sm bg-secondary px-1 py-px text-muted-foreground text-[10px] leading-3.5',
        className
      )}>
      {t('common.default')}
    </span>
  )
}
