import { Check, Download, LoaderCircle } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, ScrollArea } from '@cherrystudio/ui'
import { useInstalledSkills, useInvalidateSkills } from '@renderer/hooks/useSkills'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { skillHubSource } from '@shared/types/skillHub'

import { SkillInitialAvatar } from './SkillInitialAvatar'

const requestOptions = { shouldRetryOnError: false, revalidateOnFocus: false }

export function SkillHubCatalogView({ search }: { search: string }) {
  const { t } = useTranslation()
  const keyword = useDeferredValue(search.trim().slice(0, 200))
  const [industryId, setIndustry] = useState('')
  const [domainId, setDomain] = useState('')
  const [page, setPage] = useState({ keyword, number: 1 })
  if (page.keyword !== keyword) setPage({ keyword, number: 1 })
  const pageNum = page.keyword === keyword ? page.number : 1
  const [selected, setSelected] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const filters = useSWR('skill.skillhub.filters', () => ipcApi.request('skill.skillhub.filters', {}), requestOptions)
  const catalog = useSWR(
    ['skill.skillhub.list', keyword, industryId, domainId, pageNum] as const,
    ([, keyword, industryId, domainId, pageNum]) =>
      ipcApi.request('skill.skillhub.list', { keyword, industryId, domainId, pageNum }),
    requestOptions
  )
  const detail = useSWR(
    selected ? (['skill.skillhub.detail', selected] as const) : null,
    ([, id]) => ipcApi.request('skill.skillhub.detail', { id }),
    requestOptions
  )
  const installed = useInstalledSkills()
  const invalidate = useInvalidateSkills()
  const installedOrigins = new Set(installed.skills.flatMap((skill) => (skill.sourceUrl ? [skill.sourceUrl] : [])))

  async function install(id: string, version: string, name: string) {
    if (installing) return
    setInstalling(id)
    try {
      await ipcApi.request('skill.skillhub.install', { id, version })
      toast.success(t('settings.skills.installSuccess', { name }))
    } catch (error) {
      toast.error(
        t('settings.skills.installFailed', { name }) + ': ' + (error instanceof Error ? error.message : String(error))
      )
      void catalog.mutate().catch(() => {})
      void detail.mutate().catch(() => {})
    } finally {
      try {
        await invalidate()
      } catch {
        // The install result is independent of the following catalog refresh.
      } finally {
        setInstalling(null)
      }
    }
  }

  const retry = () => void Promise.allSettled([filters.mutate(), catalog.mutate()])
  if (filters.data === null || catalog.data === null) {
    return <p className="p-6 text-muted-foreground">{t('workspace.skillhub.unconfigured')}</p>
  }
  if (filters.error || catalog.error) {
    return (
      <div className="flex items-center gap-3 p-6">
        <p>{t('workspace.skillhub.unreachable')}</p>
        <Button onClick={retry} size="sm">
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const groups = [
    { label: t('workspace.skillhub.industry'), items: filters.data?.industries, value: industryId, set: setIndustry },
    { label: t('workspace.skillhub.domain'), items: filters.data?.domains, value: domainId, set: setDomain }
  ]
  const records = catalog.data?.records ?? []
  const goToPage = (number: number) => setPage({ keyword, number })

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-2">
        {filters.data &&
          groups.map(({ label, items, value, set }) => (
            <div key={label} role="group" aria-label={label} className="mb-2 flex flex-wrap items-center gap-1">
              <span className="min-w-10 text-muted-foreground text-xs">{label}</span>
              {[{ id: '', name: t('workspace.skill_catalog.all') }, ...(items ?? [])].map(({ id, name }) => (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  aria-pressed={value === id}
                  className={value === id ? 'h-7 bg-muted px-2.5 text-xs' : 'h-7 px-2.5 text-muted-foreground text-xs'}
                  onClick={() => {
                    set(id)
                    goToPage(1)
                  }}>
                  {name}
                </Button>
              ))}
            </div>
          ))}
        {catalog.isLoading || filters.isLoading ? (
          <p className="py-16 text-center text-muted-foreground">{t('workspace.skill_catalog.loading')}</p>
        ) : records.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">{t('workspace.skill_catalog.empty')}</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {records.map((item, index) => {
              const local = [...installedOrigins].find((origin) => origin.startsWith(`skillhub:${item.id}@`))
              const isInstalled = Boolean(local)
              const differentVersion = local && local !== skillHubSource(item.id, item.version)
              const busy = installing === item.id
              return (
                <article
                  key={item.id}
                  className="group relative min-w-0 rounded-lg border bg-background p-4 focus-within:border-border-strong hover:border-border-strong hover:bg-accent/30">
                  <button
                    type="button"
                    className="absolute inset-0 rounded-lg"
                    aria-label={item.name}
                    onClick={() => setSelected(item.id)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-3 right-3 z-10 size-7"
                    disabled={Boolean(installing) || installed.loading || Boolean(installed.error) || isInstalled}
                    aria-label={
                      isInstalled
                        ? t('workspace.skill_catalog.installed')
                        : t('workspace.skill_catalog.install', { name: item.name })
                    }
                    onClick={() => void install(item.id, item.version, item.name)}>
                    {busy ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : isInstalled ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                  </Button>
                  <div className="flex min-w-0 items-center gap-2.5 pr-8">
                    {item.iconUrl ? (
                      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-muted">
                        <img src={item.iconUrl} alt="" className="size-full object-cover" />
                      </span>
                    ) : (
                      <SkillInitialAvatar name={item.name} index={index} />
                    )}
                    <div className="min-w-0">
                      <h2 className="truncate font-semibold text-sm">{item.name}</h2>
                      <p className="truncate text-muted-foreground text-xs">
                        {[item.industry, item.domain].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-muted-foreground text-xs leading-5">
                    {item.description}
                  </p>
                  {differentVersion && (
                    <p className="text-muted-foreground text-xs">
                      {t('workspace.skillhub.version_available', { version: item.version })}
                    </p>
                  )}
                </article>
              )
            })}
          </div>
        )}
        {(catalog.data?.pages ?? 0) > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3">
            <Button size="sm" variant="outline" disabled={pageNum <= 1} onClick={() => goToPage(pageNum - 1)}>
              {t('workspace.skillhub.previous')}
            </Button>
            <span aria-live="polite">
              {pageNum} / {catalog.data?.pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pageNum >= (catalog.data?.pages ?? 0)}
              onClick={() => goToPage(pageNum + 1)}>
              {t('workspace.skillhub.next')}
            </Button>
          </div>
        )}
      </div>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail.data?.name ?? 'SkillHub'}</DialogTitle>
          </DialogHeader>
          {detail.error ? (
            <Button onClick={() => void detail.mutate().catch(() => {})}>{t('common.retry')}</Button>
          ) : detail.data ? (
            <div className="max-h-[60vh] space-y-2 overflow-auto">
              <p className="text-muted-foreground text-sm">
                {[detail.data.author, detail.data.version].filter(Boolean).join(' · ')}
              </p>
              <p>{detail.data.description}</p>
              <p className="whitespace-pre-wrap text-sm">{detail.data.guide}</p>
            </div>
          ) : (
            <p>{t('workspace.skill_catalog.loading')}</p>
          )}
        </DialogContent>
      </Dialog>
    </ScrollArea>
  )
}
