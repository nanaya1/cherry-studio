import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { CommandPopupMenu } from '@renderer/components/command'
import { ipcApi } from '@renderer/ipc'

/** 只提交用户本次选择；结果未知时锁住入口，刷新目录核对后再人工操作。 */
export default function KnowledgeSourceUpload({
  baseId,
  parentId,
  onChanged
}: {
  baseId: string
  parentId: string | null
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const active = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const upload = async (kind: 'file' | 'directory') => {
    if (inFlight.current || error) return
    inFlight.current = true
    setBusy(true)
    setCompleted(false)
    try {
      const submitted = await ipcApi.request('enterprise.knowledge.upload_source', { baseId, parentId, kind })
      if (active.current && submitted) {
        setCompleted(true)
        await Promise.resolve(onChanged()).catch(() => {})
      }
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await Promise.resolve(onChanged()).catch(() => {})
      }
    } finally {
      inFlight.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <div className="flex max-w-96 flex-wrap items-center justify-end gap-2">
      {error ? (
        <>
          <p role="alert" className="text-xs text-error">
            {error} · {t('knowledge.org.native_upload_review')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (inFlight.current) return
              inFlight.current = true
              setBusy(true)
              try {
                await onChanged()
                if (active.current) setError(null)
              } catch (cause) {
                if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                inFlight.current = false
                if (active.current) setBusy(false)
              }
            }}>
            {t('knowledge.org.refresh')}
          </Button>
        </>
      ) : null}
      {busy || completed ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t(busy ? 'common.loading' : 'knowledge.org.native_upload_submitted')}
        </span>
      ) : null}
      <CommandPopupMenu
        location="webcontents.context"
        align="end"
        side="bottom"
        disabled={busy || !!error}
        extraItems={(['file', 'directory'] as const).map((kind) => ({
          type: 'item' as const,
          id: kind,
          label: t(
            kind === 'file'
              ? 'knowledge.data_source.add_dialog.sources.file'
              : 'knowledge.data_source.add_dialog.sources.directory'
          ),
          onSelect: () => {
            void upload(kind)
          }
        }))}>
        <Button variant="outline" size="sm" disabled={busy || !!error}>
          {t('knowledge.data_source.toolbar.add')}
          <ChevronDown className="size-3.5" />
        </Button>
      </CommandPopupMenu>
    </div>
  )
}
