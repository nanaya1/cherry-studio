import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { InspectionSpace } from '@shared/data/types/knowledgeInspection'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import InspectionPager from './InspectionPager'
import InspectionQueryState from './InspectionQueryState'

export default function KnowledgeInspectionNavigator({
  selected,
  onSelect
}: {
  selected: InspectionSpace | null
  onSelect: (base: InspectionSpace | null) => void
}) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.spaces', { page, keyword: search }),
    [page, search]
  )
  const query = useInspectionQuery(load)
  return (
    <section className="space-y-2" aria-label={t('knowledge.inspection.all')}>
      <p className="px-1 text-xs text-muted-foreground">{t('knowledge.inspection.scope_hint')}</p>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          onSelect(null)
          setPage(1)
          setSearch(keyword.trim())
          query.reload()
        }}>
        <Input
          value={keyword}
          maxLength={100}
          onChange={(event) => setKeyword(event.target.value)}
          aria-label={t('knowledge.inspection.search')}
          placeholder={t('knowledge.inspection.search')}
        />
        <Button type="submit" size="sm" variant="outline">
          {t('knowledge.inspection.search_action')}
        </Button>
      </form>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">{t('knowledge.org.empty_bases')}</p>
          ) : null}
          {query.data.items.map((base) => (
            <Button
              key={base.id}
              variant={selected?.id === base.id ? 'secondary' : 'ghost'}
              className="h-auto w-full flex-col items-start whitespace-normal py-2 text-left"
              aria-pressed={selected?.id === base.id}
              onClick={() => onSelect(base)}>
              <span className="line-clamp-2 break-all">{base.name}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('knowledge.inspection.owner', {
                  name: base.ownerName || base.ownerId || t('knowledge.inspection.unknown')
                })}
              </span>
            </Button>
          ))}
          <InspectionPager
            page={page}
            total={query.data.total}
            onChange={(value) => {
              onSelect(null)
              setPage(value)
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSelect(null)
              query.reload()
            }}>
            {t('knowledge.org.refresh')}
          </Button>
        </>
      ) : null}
    </section>
  )
}
