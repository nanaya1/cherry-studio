import { ExternalLink, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ResourceList } from '@renderer/components/chat/resourceList/base'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'

/** MEA:enterprise-knowledge-page URL和当前企业角色均由主进程复核。 */
export default function KnowledgeWebButton({ baseId, create = false }: { baseId?: string; create?: boolean }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const openWeb = async () => {
    setBusy(true)
    try {
      await ipcApi.request('enterprise.knowledge.open_web_management', { baseId, create })
    } catch (error) {
      if (active.current) toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (active.current) setBusy(false)
    }
  }

  if (create) {
    return (
      <div className="flex shrink-0 flex-col rounded-lg border border-border bg-background">
        <ResourceList.HeaderItem
          type="button"
          icon={<Plus />}
          label={t('knowledge.add.title')}
          aria-label={t('knowledge.add.title')}
          disabled={busy}
          onClick={openWeb}
        />
      </div>
    )
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={openWeb}>
      {t('knowledge.org.web_management')}
      <ExternalLink className="size-3.5" />
    </Button>
  )
}
