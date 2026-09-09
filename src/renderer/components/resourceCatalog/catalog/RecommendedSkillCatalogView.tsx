import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Scrollbar, Tooltip } from '@cherrystudio/ui'
import { useMutation, useQuery } from '@renderer/data/hooks/useDataApi'
import { toast } from '@renderer/services/toast'
import type { SkillCatalogItem } from '@shared/data/api/schemas/skillCatalog'
import { Check, Download, List, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RecommendedSkillCatalogViewProps {
  search: string
}

function SkillDimensionTags({ items }: { items: SkillCatalogItem['professionalDimensions'] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(items.length)

  const measure = useCallback(() => {
    const container = containerRef.current
    const measureRow = measureRef.current
    if (!container || !measureRow) return

    const tags = Array.from(measureRow.children) as HTMLElement[]
    const availableWidth = container.clientWidth
    const gap = 4
    const widths = tags.map((tag) => tag.offsetWidth)
    const totalWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
    if (totalWidth <= availableWidth) {
      setVisibleCount(items.length)
      return
    }

    let nextVisibleCount = 0
    let usedWidth = 0
    for (let index = 0; index < widths.length; index += 1) {
      const remainingCount = items.length - index
      const overflowWidth = Math.max(24, 12 + String(remainingCount).length * 6)
      const nextWidth = usedWidth + (index > 0 ? gap : 0) + widths[index] + gap + overflowWidth
      if (nextWidth > availableWidth) break
      usedWidth += (index > 0 ? gap : 0) + widths[index]
      nextVisibleCount = index + 1
    }
    setVisibleCount(nextVisibleCount)
  }, [items])

  useEffect(() => {
    measure()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [measure])

  const hiddenItems = items.slice(visibleCount)

  return (
    <div ref={containerRef} className="relative mt-1 min-h-4 min-w-0 overflow-visible">
      <div ref={measureRef} aria-hidden className="pointer-events-none absolute flex gap-1 opacity-0">
        {items.map((item) => (
          <span
            key={item.code}
            className="inline-flex h-4 shrink-0 items-center justify-center whitespace-nowrap rounded bg-muted px-1.5 text-[10px] leading-none">
            {item.name}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-1">
        {items.slice(0, visibleCount).map((item) => (
          <span
            key={item.code}
            className="inline-flex h-4 shrink-0 items-center justify-center whitespace-nowrap rounded bg-muted px-1.5 text-[10px] text-muted-foreground leading-none">
            {item.name}
          </span>
        ))}
        {hiddenItems.length > 0 ? (
          <Tooltip
            placement="top"
            asChild
            content={
              <div className="flex max-w-56 flex-wrap gap-1">
                {hiddenItems.map((item) => (
                  <span key={item.code}>{item.name}</span>
                ))}
              </div>
            }>
            <span
              tabIndex={0}
              className="relative z-10 inline-flex h-4 shrink-0 items-center justify-center whitespace-nowrap rounded bg-muted px-1.5 text-[10px] text-muted-foreground leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring">
              +{hiddenItems.length}
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

export function RecommendedSkillCatalogView({ search }: RecommendedSkillCatalogViewProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage?.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
  const { data, isLoading, error } = useQuery('/skill-catalog', { query: { locale } })
  const [industry, setIndustry] = useState<string>('all')
  const [installing, setInstalling] = useState<string | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<SkillCatalogItem | null>(null)
  const install = useMutation('POST', '/skill-catalog/:catalogSkillId/install', {
    refresh: ['/skill-catalog', '/skills']
  })

  const skills = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return (data?.skills ?? [])
      .filter((skill) => {
        const matchesIndustry =
          industry === 'all' ||
          (industry === 'universal' && skill.industryScope === 'universal') ||
          skill.industries.some((item) => item.code === industry)
        const haystack = [
          skill.name,
          skill.description,
          ...skill.industries.map((item) => item.name),
          ...skill.professionalDimensions.map((item) => item.name)
        ]
          .join(' ')
          .toLocaleLowerCase()
        return matchesIndustry && (!query || haystack.includes(query))
      })
      .sort((left, right) => Number(left.installState === 'installed') - Number(right.installState === 'installed'))
  }, [data?.skills, industry, search])

  const handleInstall = async (skill: SkillCatalogItem) => {
    if (skill.installState === 'installed' || installing) return
    setInstalling(skill.id)
    try {
      const result = await install.trigger({ params: { catalogSkillId: skill.id } })
      setSelectedSkill((current) =>
        current?.id === skill.id
          ? { ...current, installState: 'installed', installedSkillId: result.installedSkillId }
          : current
      )
    } catch (error) {
      toast.error(
        t('settings.skills.installFailed', { name: skill.name }) + (error instanceof Error ? `: ${error.message}` : '')
      )
    } finally {
      setInstalling(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t('workspace.skill_catalog.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        {t('workspace.skill_catalog.load_failed')}
      </div>
    )
  }

  return (
    <Scrollbar className="h-full">
      <div className="mx-auto w-full px-6 py-4">
        <div className="mb-4 flex gap-1 overflow-x-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIndustry('all')}
            className={industry === 'all' ? 'h-7 bg-muted px-2.5 text-xs' : 'h-7 px-2.5 text-muted-foreground text-xs'}>
            {t('workspace.skill_catalog.all')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIndustry('universal')}
            aria-pressed={industry === 'universal'}
            className={
              industry === 'universal' ? 'h-7 bg-muted px-2.5 text-xs' : 'h-7 px-2.5 text-muted-foreground text-xs'
            }>
            {t('workspace.skill_catalog.universal')}
          </Button>
          {data?.industries.map((item) => (
            <Button
              key={item.code}
              variant="ghost"
              size="sm"
              onClick={() => setIndustry(item.code)}
              className={
                industry === item.code ? 'h-7 bg-muted px-2.5 text-xs' : 'h-7 px-2.5 text-muted-foreground text-xs'
              }>
              {item.name}
            </Button>
          ))}
        </div>

        {skills.length === 0 ? (
          <div className="py-24 text-center text-muted-foreground text-sm">{t('workspace.skill_catalog.empty')}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {skills.map((skill, index) => {
              const busy = installing === skill.id
              const installed = skill.installState === 'installed'
              return (
                <article
                  key={skill.id}
                  className="group relative flex min-w-0 flex-col rounded-lg border bg-background p-4 transition-colors duration-150 focus-within:border-border-strong hover:border-border-strong hover:bg-accent/30">
                  <button
                    type="button"
                    onClick={() => setSelectedSkill(skill)}
                    aria-label={skill.name}
                    className="absolute inset-0 rounded-lg outline-none"
                  />
                  <button
                    type="button"
                    disabled={installed || busy}
                    onClick={() => void handleInstall(skill)}
                    aria-label={
                      installed
                        ? t('workspace.skill_catalog.installed')
                        : t('workspace.skill_catalog.install', { name: skill.name })
                    }
                    className="absolute top-3 right-3 z-10 grid size-7 place-items-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-default">
                    {busy ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : installed ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                  </button>
                  <div className="flex min-w-0 items-center gap-2.5 pr-8">
                    {skill.logoUrl ? (
                      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border bg-white">
                        <img src={skill.logoUrl} alt="" className="size-full object-cover" />
                      </span>
                    ) : (
                      <span
                        className="grid size-9 shrink-0 place-items-center rounded-full font-semibold text-sm"
                        style={{
                          backgroundColor: ['#eaf6ed', '#eaf1fa', '#fff2df', '#f3edf8', '#edf3f4'][index % 5],
                          color: ['#39734b', '#496c94', '#936324', '#76578b', '#526a70'][index % 5]
                        }}>
                        {Array.from(skill.name)[0]}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-semibold text-sm">{skill.name}</h2>
                      <SkillDimensionTags items={skill.professionalDimensions} />
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-muted-foreground text-xs leading-5">
                    {skill.description}
                  </p>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={selectedSkill !== null} onOpenChange={(open) => !open && setSelectedSkill(null)}>
        <DialogContent size="xl" className="gap-0 overflow-hidden p-0">
          {selectedSkill ? (
            <div className="px-8 py-7">
              <DialogHeader className="pr-8 text-left">
                <div className="flex min-w-0 items-start gap-4">
                  {selectedSkill.logoUrl ? (
                    <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border bg-white">
                      <img src={selectedSkill.logoUrl} alt="" className="size-full object-cover" />
                    </span>
                  ) : (
                    <span
                      className="grid size-16 shrink-0 place-items-center rounded-full font-semibold text-xl"
                      style={{ backgroundColor: '#eaf6ed', color: '#39734b' }}>
                      {Array.from(selectedSkill.name)[0]}
                    </span>
                  )}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <DialogTitle className="truncate text-xl leading-7">{selectedSkill.name}</DialogTitle>
                    <Button
                      type="button"
                      size="sm"
                      disabled={selectedSkill.installState === 'installed' || installing !== null}
                      onClick={() => void handleInstall(selectedSkill)}
                      className="mt-3 min-w-20 gap-2">
                      {installing === selectedSkill.id ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : selectedSkill.installState === 'installed' ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      {selectedSkill.installState === 'installed'
                        ? t('workspace.skill_catalog.installed')
                        : t('settings.skills.install')}
                    </Button>
                  </div>
                </div>
              </DialogHeader>

              <p className="mt-5 max-w-3xl text-muted-foreground text-sm leading-6">{selectedSkill.description}</p>

              <section className="mt-7" aria-labelledby="catalog-skill-basic-info">
                <h3 id="catalog-skill-basic-info" className="flex items-center gap-2 font-medium text-sm">
                  <List className="size-4" />
                  {t('workspace.skill_catalog.basic_info')}
                </h3>
                <dl className="mt-3 rounded-lg bg-muted/60 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-6">
                    <dt className="text-muted-foreground">{t('workspace.skill_catalog.version')}</dt>
                    <dd className="font-medium tabular-nums">
                      {selectedSkill.version === 'unknown'
                        ? locale === 'zh-CN'
                          ? '未知'
                          : 'Unknown'
                        : `v${selectedSkill.version}`}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Scrollbar>
  )
}
