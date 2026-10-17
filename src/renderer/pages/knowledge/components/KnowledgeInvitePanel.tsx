import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Combobox } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { OrgKnowledgeCollaborator, OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'

import { canInviteAfterShare } from '../utils/sharing'

export default function KnowledgeInvitePanel({
  baseId,
  uploadOriginal = true,
  remote = false,
  prepared,
  busy,
  onBusyChange,
  onPrepared,
  onInvited,
  renderActions
}: {
  baseId: string
  uploadOriginal?: boolean
  remote?: boolean
  prepared?: OrgKnowledgeShareResult
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onPrepared: (result: OrgKnowledgeShareResult) => void
  onInvited: () => void
  renderActions?: (inviteButton: ReactNode) => ReactNode
}) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const [people, setPeople] = useState<OrgKnowledgeCollaborator[]>([])
  const [selected, setSelected] = useState<OrgKnowledgeCollaborator>()
  const [sent, setSent] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(prepared)
  const active = useRef(true)
  const lock = useRef(false)
  const generation = useRef(0)
  const selecting = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    const current = ++generation.current
    if (!keyword.trim()) {
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await ipcApi.request('enterprise.knowledge.collaborators', {
          keyword: keyword.trim(),
          page: 1,
          pageSize: 50
        })
        if (!cancelled && active.current && generation.current === current) setPeople(result.items)
      } catch (cause) {
        if (!cancelled && active.current && generation.current === current)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled && active.current && generation.current === current) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [keyword])
  const invite = async () => {
    if (busy || lock.current || !selected || sent.includes(selected.id)) return
    const recipient = selected
    lock.current = true
    onBusyChange(true)
    setError(null)
    try {
      // const result = copy ?? prepared ?? (await ipcApi.request('enterprise.knowledge.share', { baseId }))
      const cached = copy ?? prepared
      let target = baseId
      if (!remote) {
        const result =
          cached && canInviteAfterShare(cached)
            ? cached
            : await ipcApi.request('enterprise.knowledge.share', { baseId, uploadOriginal })
        if (!active.current) return
        setCopy(result)
        onPrepared(result)
        if (!canInviteAfterShare(result)) throw new Error(t('knowledge.org.upload_incomplete'))
        target = result.shareId
      }
      const current = await ipcApi.request('enterprise.knowledge.members', { baseId: target })
      if (!active.current) return
      if (
        current.members.some(
          (member) =>
            member.userId === recipient.id &&
            ['active', 'pending', 'invited', 'accepted', 'joined'].includes(member.status ?? '')
        )
      ) {
        setSent((previous) => [...previous, recipient.id])
        throw new Error(t('knowledge.org.member_exists'))
      }
      await ipcApi.request('enterprise.knowledge.invite', { baseId, userId: recipient.id, expireDays: 7 })
      if (!active.current) return
      setSent((previous) => [...previous, recipient.id])
      onInvited()
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (active.current) onBusyChange(false)
    }
  }
  const inviteButton = (
    <Button disabled={busy || !selected || sent.includes(selected.id)} onClick={() => void invite()}>
      {t('knowledge.org.invite')}
    </Button>
  )
  return (
    <section className="space-y-3" aria-label={t('knowledge.org.invite_people')}>
      <p className="text-sm text-muted-foreground">{t('knowledge.org.permission')}</p>
      <Combobox
        options={people.map((person) => ({
          value: String(person.id),
          label: person.username,
          disabled: sent.includes(person.id)
        }))}
        value={selected ? String(selected.id) : ''}
        searchable
        searchPlacement="trigger"
        searchPlaceholder={t('knowledge.org.search_username')}
        placeholder={t('knowledge.org.search_username')}
        emptyText={loading ? t('common.loading') : t('knowledge.org.empty_results')}
        filterOption={() => true}
        disabled={busy}
        onSearch={(value) => {
          generation.current++
          setKeyword(value)
          if (!selecting.current) {
            setPeople([])
            setSelected(undefined)
          }
          selecting.current = false
          setError(null)
        }}
        onChange={(value) => {
          const person = people.find((candidate) => String(candidate.id) === value)
          if (person && !sent.includes(person.id)) {
            selecting.current = true
            setSelected(person)
          }
        }}
      />
      {/* 原发送按钮由下方操作区承载。
      <Button disabled={busy || !selected || sent.includes(selected.id)} onClick={() => void invite()}>
        {t('knowledge.org.invite')}
      </Button>
      */}
      {sent.length > 0 ? <p role="status">{t('knowledge.org.invited')}</p> : null}
      {error ? (
        <p role="alert" className="text-error">
          {error}
        </p>
      ) : null}
      {renderActions ? renderActions(inviteButton) : inviteButton}
    </section>
  )
}
