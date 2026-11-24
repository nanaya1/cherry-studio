import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Switch } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { ExternalKnowledgeConnectorItem } from '@shared/ipc/schemas/enterprise'

import { getConnectorFallbackStyle, getConnectorInitial } from './connectorAvatar'

/** MEA:external-knowledge-connectors 仅标签激活时挂载，每次进入读取一次，离开不停止已有连接 */
export default function ExternalKnowledgeConnectorList({ visit }: { visit: number }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<ExternalKnowledgeConnectorItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const generation = useRef(0)

  useEffect(() => {
    const request = ++generation.current
    setLoading(true)
    setError(false)
    setBusy(new Set())
    void ipcApi
      .request('enterprise.knowledge_connectors.list')
      .then(
        ({ connectors }) => {
          if (generation.current === request) setItems(connectors)
        },
        () => {
          if (generation.current === request) setError(true)
        }
      )
      .finally(() => {
        if (generation.current === request) setLoading(false)
      })
    return () => {
      generation.current += 1
    }
  }, [visit])

  const toggle = async (item: ExternalKnowledgeConnectorItem, active: boolean) => {
    const request = generation.current
    setBusy((current) => new Set(current).add(item.resourceKey))
    try {
      const updated = await ipcApi.request('enterprise.knowledge_connectors.set_active', {
        resourceKey: item.resourceKey,
        active
      })
      if (generation.current === request)
        setItems((current) => current.map((entry) => (entry.resourceKey === updated.resourceKey ? updated : entry)))
    } catch {
      if (generation.current === request) {
        setItems((current) =>
          current.map((entry) => (entry.resourceKey === item.resourceKey ? { ...entry, isActive: false } : entry))
        )
        toast.error(t('settings.mcp.externalKnowledge.operationError'))
      }
    } finally {
      if (generation.current === request)
        setBusy((current) => {
          const next = new Set(current)
          next.delete(item.resourceKey)
          return next
        })
    }
  }

  if (loading)
    return (
      <div role="status" className="py-10 text-center text-muted-foreground text-sm">
        {t('common.loading')}
      </div>
    )
  if (error)
    return (
      <div role="alert" className="py-10 text-center text-muted-foreground text-sm">
        {t('settings.mcp.externalKnowledge.loadError')}
      </div>
    )
  if (items.length === 0)
    return (
      <div className="py-10 text-center text-muted-foreground text-sm">{t('settings.mcp.externalKnowledge.empty')}</div>
    )

  return (
    <div className="grid @[1120px]/mcp-discover:grid-cols-4 @[560px]/mcp-discover:grid-cols-2 @[840px]/mcp-discover:grid-cols-3 grid-cols-1 gap-3">
      {items.map((item) => (
        <div
          key={item.resourceKey}
          className="flex min-h-36 min-w-0 flex-col rounded-lg border border-border-subtle bg-card p-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-full font-semibold text-sm ${getConnectorFallbackStyle(item.name)}`}>
              {getConnectorInitial(item.name)}
            </div>
            <h3 className="min-w-0 truncate font-semibold text-base" title={item.name}>
              {item.name}
            </h3>
          </div>
          <p className="mt-3 mb-3 line-clamp-2 flex-1 text-muted-foreground text-sm">
            {item.description || t('settings.mcp.noDescriptionAvailable')}
          </p>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className="max-w-40 truncate">
              {item.kind}
            </Badge>
            <div className="flex items-center gap-2">
              {busy.has(item.resourceKey) ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
              <span className="text-muted-foreground text-xs">
                {t(item.isActive ? 'common.enabled' : 'common.disabled')}
              </span>
              <Switch
                checked={item.isActive}
                disabled={busy.has(item.resourceKey)}
                aria-label={t('settings.mcp.externalKnowledge.toggle', { name: item.name })}
                onCheckedChange={(active) => {
                  void toggle(item, active)
                }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
