import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
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
  return (
    <Button
      variant={create ? 'outline' : 'ghost'}
      size="sm"
      className={create ? 'w-full' : undefined}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await ipcApi.request('enterprise.knowledge.open_web_management', { baseId, create })
        } catch (error) {
          if (active.current) toast.error(error instanceof Error ? error.message : String(error))
        } finally {
          if (active.current) setBusy(false)
        }
      }}>
      {t(create ? 'knowledge.org.create_public_web' : 'knowledge.org.web_management')}
      <ExternalLink className="size-3.5" />
    </Button>
  )
}
