import { Check, Download, Loader2, TriangleAlert } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Center, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyState, Spinner } from '@cherrystudio/ui'
import { ResourceCatalogSearchInput } from '@renderer/components/resourceCatalog/ResourceCatalogSearchInput'
import { useOrgSkills, type OrgSkillItem } from '@renderer/hooks/useOrgSkills'
import { toast } from '@renderer/services/toast'

// [enterprise] T0 企业技能目录弹窗：展示组织下发的技能，点击安装到本地技能库
type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OrgSkillDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // [enterprise] C2/C4：disabledSlugs 停用提示 + remove 删除上报
  const { skills, loading, error, install, installing, refetch, disabledSlugs, remove } = useOrgSkills(open)
  const [lastError, setLastError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Set<string>>(() => new Set())

  const handleRemove = useCallback(
    async (skill: OrgSkillItem) => {
      setLastError(null)
      setRemoving((current) => new Set(current).add(skill.slug))
      try {
        await remove(skill.slug)
        toast.success(t('library.org_skill.remove_success', { name: skill.name }))
        await refetch()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setLastError(message)
        toast.error(message)
      } finally {
        setRemoving((current) => {
          const next = new Set(current)
          next.delete(skill.slug)
          return next
        })
      }
    },
    [remove, refetch, t]
  )

  const visibleSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.slug].some((value) => value?.toLowerCase().includes(normalizedQuery))
    )
  }, [query, skills])

  const handleInstall = useCallback(
    async (skill: OrgSkillItem) => {
      setLastError(null)
      try {
        await install(skill.slug)
        toast.success(t('library.org_skill.install_success', { name: skill.name }))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setLastError(message)
        toast.error(message)
      }
    },
    [install, t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeOnOverlayClick
        size="xl"
        className="flex h-[min(640px,82vh)] flex-col gap-0 overflow-hidden p-0"
        data-testid="org-skill-dialog">
        <div className="shrink-0 border-b border-border-subtle px-6 pt-5 pb-4">
          <DialogHeader className="min-w-0 text-left">
            <DialogTitle>{t('library.org_skill.title')}</DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">{t('library.org_skill.description')}</p>
          </DialogHeader>
          <div className="mt-3 flex items-center gap-2">
            <ResourceCatalogSearchInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={t('library.org_skill.search_placeholder')}
              className="flex-1"
            />
            <Button variant="ghost" size="sm" onClick={() => void refetch()} className="shrink-0">
              {t('common.refresh')}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {loading && skills.length === 0 ? (
            <Center className="min-h-0 flex-1 text-sm text-foreground-tertiary">
              <Spinner text={t('common.loading')} />
            </Center>
          ) : error ? (
            <EmptyState preset="no-result" title={t('common.error')} description={error} className="min-h-0 flex-1" />
          ) : skills.length === 0 ? (
            <EmptyState
              preset="no-resource"
              title={t('library.org_skill.empty_title')}
              description={t('library.org_skill.empty_description')}
              className="min-h-0 flex-1"
            />
          ) : visibleSkills.length === 0 ? (
            <EmptyState preset="no-result" title={t('common.no_results')} className="min-h-0 flex-1" />
          ) : (
            <div role="list" className="min-h-0 flex-1 overflow-y-auto px-6 py-1">
              {visibleSkills.map((skill) => (
                <OrgSkillRow
                  key={skill.slug}
                  skill={skill}
                  installing={installing.has(skill.slug)}
                  error={lastError}
                  disabled={disabledSlugs.includes(skill.slug)}
                  removing={removing.has(skill.slug)}
                  onInstall={() => void handleInstall(skill)}
                  onRemove={() => void handleRemove(skill)}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OrgSkillRow({
  skill,
  installing,
  error,
  disabled = false,
  removing = false,
  onInstall,
  onRemove
}: {
  skill: OrgSkillItem
  installing: boolean
  error: string | null
  // [enterprise] C2：企业已停用/下架 → 提示"可删除"
  disabled?: boolean
  // [enterprise] C4：删除进行中
  removing?: boolean
  onInstall: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="listitem"
      className="flex min-h-20 items-center gap-4 border-b border-border-subtle px-2 py-3 last:border-b-0">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground-tertiary">
        {error ? <TriangleAlert className="size-4" /> : <Download className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[13px] text-foreground">{skill.name}</span>
          <span className="shrink-0 text-foreground-tertiary text-xs">v{skill.version}</span>
          {/* [enterprise] C2：停用徽标（本地已保留但不再注入新会话） */}
          {disabled ? (
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-foreground-tertiary text-[11px] leading-none">
              {t('library.org_skill.disabled_badge')}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-muted-foreground text-xs">{skill.description}</p>
      </div>
      {/* [enterprise] C2/C4：停用项显示"删除"（上报 deleted + 本地卸载），正常项显示"安装" */}
      {disabled ? (
        <Button variant="outline" size="sm" disabled={removing} onClick={onRemove} className="shrink-0">
          {removing ? <Loader2 className="size-3 animate-spin" /> : null}
          {removing ? t('library.org_skill.removing') : t('library.org_skill.remove')}
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={installing} onClick={onInstall} className="shrink-0">
          {installing ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          {installing ? t('library.org_skill.installing') : t('library.org_skill.install')}
        </Button>
      )}
    </div>
  )
}
