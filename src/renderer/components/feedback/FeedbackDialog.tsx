import {
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { ChevronRight, Github } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export const FEEDBACK_GITHUB_URL = 'https://github.com/CherryHQ/cherry-studio/issues/new/choose'

const logger = loggerService.withContext('FeedbackDialog')

// 「发送诊断报告 → Cherry 厂商云」入口暂时隐藏。Mea Cowork 暂不开放向 api.cherry-ai.com 上传诊断包，
// 恢复时取消下方注释并把 FeedbackOption 的 import 改回原来的分组版本。
/* const DiagnosticUploadDialog = lazy(() => import('./DiagnosticUploadDialog')) */

interface FeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface FeedbackOptionProps {
  description: string
  icon: ReactNode
  recommended?: boolean
  title: string
  onSelect: () => void | Promise<void>
}

function FeedbackOption({ description, icon, recommended = false, title, onSelect }: FeedbackOptionProps) {
  const { t } = useTranslation()

  return (
    <Item asChild size="sm" variant="outline" className="w-full cursor-pointer rounded-xl hover:bg-accent/50">
      <button type="button" onClick={() => void onSelect()}>
        <ItemMedia
          variant="icon"
          className="border-primary/20 bg-primary/10 text-primary [&_.lucide:not(.lucide-custom)]:text-current!">
          {icon}
        </ItemMedia>
        <ItemContent className="min-w-0 text-left">
          <ItemTitle>
            {title}
            {recommended ? (
              <Badge className="border-primary/20 bg-primary/10 text-primary">
                {t('settings.about.feedback.recommended')}
              </Badge>
            ) : null}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">{description}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <ChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </button>
    </Item>
  )
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const { t } = useTranslation()
  // 「发送诊断报告」入口暂时隐藏，详见顶部注释。
  /* const [diagnosticUploadOpen, setDiagnosticUploadOpen] = useState(false) */

  const selectOption = (action: () => void | Promise<void>) => {
    onOpenChange(false)
    window.setTimeout(() => {
      void Promise.resolve()
        .then(action)
        .catch((error) => logger.error('Failed to run deferred feedback action', error as Error))
    }, 0)
  }

  const openGitHubIssue = async () => {
    try {
      await ipcApi.request('system.shell.open_website', FEEDBACK_GITHUB_URL)
    } catch (error) {
      logger.error('Failed to open GitHub issue chooser', error as Error)
      toast.error(t('settings.about.feedback.github.error'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('settings.about.feedback.dialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.about.feedback.dialog.description')}</DialogDescription>
        </DialogHeader>

        <ItemGroup className="gap-3 px-2">
          {/* 「发送诊断报告」入口暂时隐藏：Mea Cowork 暂不开放向 api.cherry-ai.com 上传诊断包。 */}
          {/*
          <FeedbackOption
            icon={<FileArchive className="size-5" />}
            title={t('settings.about.feedback.diagnostics.title')}
            description={t('settings.about.feedback.diagnostics.description')}
            recommended
            onSelect={() => selectOption(() => setDiagnosticUploadOpen(true))}
          />
          */}
          <FeedbackOption
            icon={<Github className="size-5" />}
            title={t('settings.about.feedback.github.title')}
            description={t('settings.about.feedback.github.description')}
            onSelect={() => selectOption(openGitHubIssue)}
          />
        </ItemGroup>
      </DialogContent>
    </Dialog>
  )
}

export default FeedbackDialog
