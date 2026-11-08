import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@cherrystudio/ui'
import IndustrialVideoKnowledgePicker from './IndustrialVideoKnowledgePicker'

export function IndustrialVideoMaterialControl({
  disabled = false,
  onUpload,
  onKnowledge
}: {
  disabled?: boolean
  onUpload: () => void | Promise<void>
  onKnowledge: (id: string, name: string) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" disabled={disabled} aria-label={t('industrial_video.add_material')}>
            <Plus size={18} />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="flex w-56 flex-col p-1">
          <Button
            variant="ghost"
            className="justify-start"
            disabled={disabled}
            onClick={() => {
              setOpen(false)
              void onUpload()
            }}>
            {t('industrial_video.upload')}
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={disabled}
            onClick={() => {
              setOpen(false)
              setKnowledgeOpen(true)
            }}>
            {t('industrial_video.local_knowledge')}
          </Button>
        </PopoverContent>
      </Popover>
      <Dialog open={knowledgeOpen} onOpenChange={setKnowledgeOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-xl max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('industrial_video.local_knowledge')}</DialogTitle>
          </DialogHeader>
          <IndustrialVideoKnowledgePicker
            disabled={disabled}
            onSelect={(id, name) => {
              setKnowledgeOpen(false)
              void onKnowledge(id, name)
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
