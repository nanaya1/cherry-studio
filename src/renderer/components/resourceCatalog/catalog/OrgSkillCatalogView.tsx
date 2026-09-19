import { Button, EmptyState, Spinner, Tooltip } from '@cherrystudio/ui'
import { Building2, Check, Loader2, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ResourceCatalogSearchInput } from '@renderer/components/resourceCatalog/ResourceCatalogSearchInput'
import { useOrgSkills, type OrgSkillItem } from '@renderer/hooks/useOrgSkills'
import { toast } from '@renderer/services/toast'

// [enterprise] 组织技能卡片视图（技能首页「组织」二级 tab）
// 卡片形态对齐 RecommendedSkillCatalogView：网格 + 右上角操作按钮 + 已装 ✓ 状态。
const FALLBACK_COLORS = [
  ['#eaf6ed', '#39734b'],
  ['#eaf1fa', '#496c94'],
  ['#fff2df', '#936324'],
  ['#f3edf8', '#76578b'],
  ['#edf3f4', '#526a70']
] as const

export function OrgSkillCatalogView() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const { skills, loading, error, install, installing, refetch, disabledSlugs, installedSlugs, remove } =
    useOrgSkills(true)
  const [removing, setRemoving] = useState<Set<string>>(() => new Set())

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.slug].some((value) => value?.toLocaleLowerCase().includes(normalized))
    )
  }, [query, skills])

  const handleInstall = async (skill: OrgSkillItem) => {
    if (installing.has(skill.slug) || installedSlugs.has(skill.slug)) return
    try {
      await install(skill.slug)
      toast.success(t('library.org_skill.install_success', { name: skill.name }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleRemove = async (skill: OrgSkillItem) => {
    setRemoving((current) => new Set(current).add(skill.slug))
    try {
      await remove(skill.slug)
      toast.success(t('library.org_skill.remove_success', { name: skill.name }))
      await refetch()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemoving((current) => {
        const next = new Set(current)
        next.delete(skill.slug)
        return next
      })
    }
  }

  if (loading && skills.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner text={t('common.loading')} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <EmptyState preset="no-result" title={t('common.error')} description={error} />
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t('common.refresh')}
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full flex-col px-6 py-4">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <ResourceCatalogSearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t('library.org_skill.search_placeholder')}
          className="w-64 max-w-[32vw] max-lg:w-40"
        />
        <span className="text-foreground-tertiary text-xs tabular-nums">
          {visibleSkills.length} / {skills.length}
        </span>
      </div>

      {skills.length === 0 ? (
        <EmptyState
          preset="no-resource"
          title={t('library.org_skill.empty_title')}
          description={t('library.org_skill.empty_description')}
          className="flex-1"
        />
      ) : visibleSkills.length === 0 ? (
        <EmptyState preset="no-result" title={t('common.no_results')} className="flex-1" />
      ) : (
        <div className="grid grid-cols-1 gap-3 overflow-y-auto pb-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleSkills.map((skill, index) => {
            const busy = installing.has(skill.slug)
            const isInstalled = installedSlugs.has(skill.slug)
            const isDisabled = disabledSlugs.includes(skill.slug)
            const isRemoving = removing.has(skill.slug)
            const [bg, fg] = FALLBACK_COLORS[index % FALLBACK_COLORS.length]
            return (
              <article
                key={skill.slug}
                className="group relative flex min-w-0 flex-col rounded-lg border bg-background p-4 transition-colors duration-150 hover:border-border-strong hover:bg-accent/30">
                {isDisabled ? (
                  <Tooltip
                    placement="top"
                    asChild
                    content={<div className="max-w-56">{t('library.org_skill.disabled_badge')}</div>}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={isRemoving}
                      aria-label={t('library.org_skill.remove')}
                      onClick={() => void handleRemove(skill)}
                      className="absolute top-2 right-2 z-10 text-muted-foreground hover:text-error">
                      {isRemoving ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </Button>
                  </Tooltip>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={isInstalled || busy}
                    aria-label={
                      isInstalled
                        ? t('library.org_skill.installed')
                        : busy
                          ? t('library.org_skill.installing')
                          : t('library.org_skill.install')
                    }
                    onClick={() => void handleInstall(skill)}
                    className="absolute top-2 right-2 z-10 text-muted-foreground hover:text-foreground disabled:cursor-default">
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isInstalled ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Building2 className="size-3.5" />
                    )}
                  </Button>
                )}
                <div className="flex min-w-0 items-center gap-2.5 pr-8">
                  <span
                    className="grid size-9 shrink-0 place-items-center rounded-full font-semibold text-sm"
                    style={{ backgroundColor: bg, color: fg }}>
                    {Array.from(skill.name)[0] ?? '?'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold text-sm">{skill.name}</h2>
                    <span className="text-foreground-tertiary text-xs">v{skill.version}</span>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-muted-foreground text-xs leading-5">
                  {skill.description}
                </p>
                {isDisabled ? (
                  <span className="mt-2 shrink-0 self-start rounded bg-secondary px-1.5 py-0.5 text-foreground-tertiary text-[11px] leading-none">
                    {t('library.org_skill.disabled_badge')}
                  </span>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
