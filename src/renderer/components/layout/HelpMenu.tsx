import { ChevronRight, CircleQuestionMark, FileArchive, Sparkles, Stethoscope } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, MenuItem, MenuList, Popover, PopoverContent, PopoverTrigger } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { DoctorPopup } from '@renderer/components/doctor'
import { useAccountSubmenu } from '@renderer/hooks/useAccountSubmenu'
import { useOpenReleaseNotes } from '@renderer/hooks/useOpenReleaseNotes'
import { ENABLE_CHERRY_OFFICIAL_SERVICES } from '@shared/utils/constants'

const logger = loggerService.withContext('HelpMenu')

export function HelpMenu({ onRequestClose }: { onRequestClose?: () => void }) {
  const { t } = useTranslation()
  const openReleaseNotes = useOpenReleaseNotes()
  const {
    open: menuOpen,
    onOpenChange: setMenuOpen,
    initialFocusRef: firstActionRef,
    triggerProps,
    contentProps
  } = useAccountSubmenu()
  const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null)

  const runAfterClose = (action: () => void | Promise<void>) => {
    pendingActionRef.current = action
    setMenuOpen(false)
  }

  // Cherry 官方文档与反馈入口在 MEA Cowork 中保持下线，原逻辑保留在 git 历史中。

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      aria-label={t('help.title')}
      size="sm"
      {...triggerProps}
      className="h-8 min-h-8 w-full justify-start gap-2 rounded-md bg-transparent px-2 py-0 text-[13px] text-foreground leading-5">
      <CircleQuestionMark className="!text-muted-foreground size-4" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{t('help.title')}</span>
      <ChevronRight className="!text-muted-foreground size-4" aria-hidden />
    </Button>
  )

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          align="end"
          side="right"
          sideOffset={8}
          className="w-52 rounded-md p-1.5"
          {...contentProps}
          onCloseAutoFocus={(event) => {
            contentProps.onCloseAutoFocus(event)
            const action = pendingActionRef.current
            if (!action) return
            pendingActionRef.current = null
            event.preventDefault()
            void Promise.resolve()
              .then(() => {
                onRequestClose?.()
                return action()
              })
              .catch((error) => logger.error('Failed to run help menu action', error as Error))
          }}>
          <MenuList className="gap-0.5">
            <MenuItem
              size="sm"
              className="h-8 gap-2 rounded-md border-0 bg-transparent px-2 py-0 text-[13px] leading-5 [&_svg]:text-muted-foreground"
              ref={firstActionRef}
              icon={<Sparkles size={16} />}
              label={t('help.whats_new')}
              onClick={() => runAfterClose(openReleaseNotes)}
            />
            <MenuItem
              size="sm"
              className="h-8 gap-2 rounded-md border-0 bg-transparent px-2 py-0 text-[13px] leading-5 [&_svg]:text-muted-foreground"
              icon={<FileArchive size={16} />}
              label={t(
                ENABLE_CHERRY_OFFICIAL_SERVICES
                  ? 'settings.about.feedback.diagnostics.title'
                  : 'settings.doctor.panels.export'
              )}
              onClick={() =>
                runAfterClose(async () => {
                  await DoctorPopup.show({ initialPanel: ENABLE_CHERRY_OFFICIAL_SERVICES ? 'report' : 'export' })
                })
              }
            />
            <MenuItem
              size="sm"
              className="h-8 gap-2 rounded-md border-0 bg-transparent px-2 py-0 text-[13px] leading-5 [&_svg]:text-muted-foreground"
              icon={<Stethoscope size={16} />}
              label={t('settings.doctor.entry.title')}
              onClick={() =>
                runAfterClose(async () => {
                  await DoctorPopup.show({ initialPanel: 'checks' })
                })
              }
            />
          </MenuList>
        </PopoverContent>
      </Popover>
    </>
  )
}
