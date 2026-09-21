import { Check, Download, LoaderCircle, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, Spinner, Tooltip } from '@cherrystudio/ui'
import { useOrgSkills, type OrgSkillFacet, type OrgSkillItem } from '@renderer/hooks/useOrgSkills'
import { toast } from '@renderer/services/toast'

import { SkillDimensionTags } from './RecommendedSkillCatalogView'

// [enterprise] 组织技能卡片视图（技能首页「组织」二级 tab）
// 卡片形态对齐 RecommendedSkillCatalogView：网格 + 右上角操作按钮 + 已装 ✓ 状态。
// [enterprise] 分类/标签对齐推荐视图分工：categories 做筛选 tab（全部/待分类/并集），tags 做卡片标签行。
const FALLBACK_COLORS = [
  ['#eaf6ed', '#39734b'],
  ['#eaf1fa', '#496c94'],
  ['#fff2df', '#936324'],
  ['#f3edf8', '#76578b'],
  ['#edf3f4', '#526a70']
] as const

// 分类筛选值：'all' / 'uncategorized'（待分类）/ 具体分类 code
type CategoryFilter = 'all' | 'uncategorized' | string

interface OrgSkillCatalogViewProps {
  search?: string
}

export function OrgSkillCatalogView({ search = '' }: OrgSkillCatalogViewProps) {
  const { t } = useTranslation()
  // const [query, setQuery] = useState('')
  // [enterprise] 公共目录：所有人看到同一套公共资源，未登录也能浏览与安装。
  // 登录态仅用于设置区显示账号卡片，不再控制目录请求；会话变化由主进程可选埋点承担。
  const { skills, loading, error, install, installing, refetch, disabledSlugs, installedSlugs, remove } =
    useOrgSkills(true)
  const [removing, setRemoving] = useState<Set<string>>(() => new Set())
  const [failedIcons, setFailedIcons] = useState<Set<string>>(() => new Set())
  // [enterprise] 分类筛选（'all' | 'uncategorized' | 分类 code）
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')

  // [enterprise] 遍历技能收集分类并集（按 code 去重，保持首次出现顺序），「全部/待分类」固定
  const categoryFacets = useMemo(() => {
    const byCode = new Map<string, OrgSkillFacet>()
    for (const skill of skills) {
      for (const category of skill.categories ?? []) {
        if (!byCode.has(category.code)) byCode.set(category.code, category)
      }
    }
    return Array.from(byCode.values())
  }, [skills])

  const visibleSkills = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase()
    return skills.filter((skill) => {
      const matchesCategory =
        categoryFilter === 'all' ||
        (categoryFilter === 'uncategorized'
          ? (skill.categories?.length ?? 0) === 0
          : skill.categories?.some((item) => item.code === categoryFilter))
      if (!matchesCategory) return false
      if (!normalized) return true
      // 搜索范围与推荐视图一致：名称/描述/slug + 分类/标签名
      return [
        skill.name,
        skill.description,
        skill.slug,
        ...(skill.categories ?? []).map((item) => item.name),
        ...(skill.tags ?? []).map((item) => item.name)
      ].some((value) => value?.toLocaleLowerCase().includes(normalized))
    })
  }, [skills, categoryFilter, search])

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
      {/* [enterprise] 分类筛选 tab：全部 / 待分类 固定，其余为分类并集（对齐推荐视图 tab 栏形态） */}
      {skills.length > 0 ? (
        <div className="mb-4 flex gap-1 overflow-x-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCategoryFilter('all')}
            className={
              categoryFilter === 'all' ? 'h-7 bg-muted px-2.5 text-xs' : 'h-7 px-2.5 text-muted-foreground text-xs'
            }>
            {t('workspace.skill_catalog.all')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCategoryFilter('uncategorized')}
            aria-pressed={categoryFilter === 'uncategorized'}
            className={
              categoryFilter === 'uncategorized'
                ? 'h-7 bg-muted px-2.5 text-xs'
                : 'h-7 px-2.5 text-muted-foreground text-xs'
            }>
            {t('workspace.skill_catalog.uncategorized')}
          </Button>
          {categoryFacets.map((item) => (
            <Button
              key={item.code}
              variant="ghost"
              size="sm"
              onClick={() => setCategoryFilter(item.code)}
              className={
                categoryFilter === item.code
                  ? 'h-7 bg-muted px-2.5 text-xs'
                  : 'h-7 px-2.5 text-muted-foreground text-xs'
              }>
              {item.name}
            </Button>
          ))}
        </div>
      ) : null}
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
                    {/* 按钮形态与推荐技能卡片操作按钮对齐（裸 button + hover 边框底色），仅图标换成删除 */}
                    <button
                      type="button"
                      disabled={isRemoving}
                      aria-label={t('library.org_skill.remove')}
                      onClick={() => void handleRemove(skill)}
                      className="absolute top-3 right-3 z-10 grid size-7 place-items-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-default">
                      {isRemoving ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                  </Tooltip>
                ) : (
                  // 按钮样式与 RecommendedSkillCatalogView 卡片安装按钮完全一致（下载图标 + 已装 ✓ 禁用态）
                  <button
                    type="button"
                    disabled={isInstalled || busy}
                    onClick={() => void handleInstall(skill)}
                    aria-label={
                      isInstalled
                        ? t('library.org_skill.installed')
                        : busy
                          ? t('library.org_skill.installing')
                          : t('library.org_skill.install')
                    }
                    className="absolute top-3 right-3 z-10 grid size-7 place-items-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-default">
                    {busy ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : isInstalled ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                  </button>
                )}
                <div className="flex min-w-0 items-center gap-2.5 pr-8">
                  <span
                    className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-sm"
                    style={{ backgroundColor: bg, color: fg }}>
                    {skill.iconUrl && !failedIcons.has(skill.slug) ? (
                      <img
                        src={skill.iconUrl}
                        alt=""
                        className="size-full object-cover"
                        draggable={false}
                        onError={() => setFailedIcons((current) => new Set(current).add(skill.slug))}
                      />
                    ) : (
                      (Array.from(skill.name.trim())[0]?.toLocaleUpperCase() ?? '?')
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold text-sm">{skill.name}</h2>
                    {/* [enterprise] 卡片标签行只显示 tags（categories 仅用于筛选 tab，对齐推荐视图分工） */}
                    {(skill.tags?.length ?? 0) > 0 ? (
                      <SkillDimensionTags items={skill.tags} />
                    ) : (
                      <span className="text-foreground-tertiary text-xs">v{skill.version}</span>
                    )}
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
