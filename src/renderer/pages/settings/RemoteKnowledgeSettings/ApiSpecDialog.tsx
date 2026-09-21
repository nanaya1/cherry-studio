import { BookOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@cherrystudio/ui'
import { StaticMarkdown } from '@renderer/components/markdown'

import specMarkdown from './api-spec.md?raw'

export function ApiSpecDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="flex flex-col max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t('settings.remoteKnowledge.apiSpec.title')}</DialogTitle>
        </DialogHeader>
        <div className="markdown min-h-0 flex-1 overflow-auto">
          <StaticMarkdown id="remote-knowledge-api-spec">{specMarkdown}</StaticMarkdown>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ViewApiSpecButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()

  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      <BookOpen className="size-4" />
      {t('settings.remoteKnowledge.apiSpec.viewDocs')}
    </Button>
  )
}
