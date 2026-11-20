import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Combobox } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { OrgKnowledgeCollaborator, OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'
import { enterpriseKnowledgeErrorCodes as E } from '@shared/ipc/errors/enterpriseKnowledge'

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
  canContinue,
  onSettled,
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
  canContinue?: () => boolean
  onSettled?: () => void
  renderActions?: (inviteButton: ReactNode) => ReactNode
}) {
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const [people, setPeople] = useState<OrgKnowledgeCollaborator[]>([])
  const [selected, setSelected] = useState<OrgKnowledgeCollaborator>()
  const [sent, setSent] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [needsUpload, setNeedsUpload] = useState(false)
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
    // if (!keyword.trim()) {
    if (!keyword.trim() || needsUpload) {
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await ipcApi.request('enterprise.knowledge.collaborators', {
          baseId,
          keyword: keyword.trim(),
          page: 1,
          pageSize: 50
        })
        if (!cancelled && active.current && generation.current === current) setPeople(result.items)
      } catch (cause) {
        // if (!cancelled && active.current && generation.current === current)
        //   setError(cause instanceof Error ? cause.message : String(cause))
        // 查询失败时收起候选层，避免遮挡真实错误并误报“没有匹配结果”。
        if (!cancelled && active.current && generation.current === current) {
          const incomplete =
            !remote &&
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === E.ORGKB_SHARE_INCOMPLETE
          setNeedsUpload(incomplete)
          setSearchError(
            incomplete
              ? t('knowledge.org.invite_upload_required')
              : cause instanceof Error
                ? cause.message
                : String(cause)
          )
          setSearchOpen(false)
        }
      } finally {
        if (!cancelled && active.current && generation.current === current) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // }, [baseId, keyword])
  }, [baseId, keyword, needsUpload, remote, t])
  const prepareInvite = async () => {
    if (busy || lock.current) return
    lock.current = true
    onBusyChange(true)
    setError(null)
    try {
      // MEA:enterprise-knowledge-page 首次候选查询保留共享校验，由用户明确启动上传后再重试原查询。
      const result = await ipcApi.request('enterprise.knowledge.share', { baseId, uploadOriginal })
      if (!(canContinue ? canContinue() : active.current)) return
      if (!active.current) return
      setCopy(result)
      onPrepared(result)
      if (!canInviteAfterShare(result)) {
        const failedFile = result.files.find((file) => file.status !== 'success' && file.error)
        throw new Error(result.error ?? failedFile?.error ?? t('knowledge.org.upload_incomplete'))
      }
      setNeedsUpload(false)
      setSearchError(null)
      setSearchOpen(true)
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (active.current) onBusyChange(false)
      if (canContinue?.()) onSettled?.()
    }
  }
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
        if (!(canContinue ? canContinue() : active.current)) return
        if (active.current) {
          setCopy(result)
          onPrepared(result)
        }
        if (!canInviteAfterShare(result)) throw new Error(t('knowledge.org.upload_incomplete'))
        target = result.shareId
      }
      const current = await ipcApi.request('enterprise.knowledge.members', { baseId: target })
      if (!(canContinue ? canContinue() : active.current)) return
      if (
        current.members.some(
          (member) =>
            member.userId === recipient.id &&
            ['active', 'pending', 'invited', 'accepted', 'joined'].includes(member.status ?? '')
        )
      ) {
        if (active.current) setSent((previous) => [...previous, recipient.id])
        throw new Error(t('knowledge.org.member_exists'))
      }
      await ipcApi.request('enterprise.knowledge.invite', { baseId, userId: recipient.id, expireDays: 7 })
      if (!(canContinue ? canContinue() : active.current)) return
      if (active.current) setSent((previous) => [...previous, recipient.id])
      else toast.success(t('knowledge.org.invited'))
      onInvited()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (active.current) setError(message)
      else if (canContinue?.()) toast.error(message)
    } finally {
      lock.current = false
      if (active.current) onBusyChange(false)
      if (canContinue?.()) onSettled?.()
    }
  }
  const inviteButton = (
    <Button disabled={busy || !selected || sent.includes(selected.id)} onClick={() => void invite()}>
      {t('knowledge.org.invite')}
    </Button>
  )
  const actionButton = needsUpload ? (
    <Button disabled={busy} onClick={() => void prepareInvite()}>
      {t('knowledge.org.invite_prepare')}
    </Button>
  ) : (
    inviteButton
  )
  return (
    <section className="space-y-3" aria-label={t('knowledge.org.invite_people')}>
      <p className="text-sm text-muted-foreground">{t('knowledge.org.permission')}</p>
      {error || searchError ? (
        <p role="alert" className="text-error break-words whitespace-pre-wrap">
          {error ?? searchError}
        </p>
      ) : null}
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
        // disabled={busy}
        disabled={busy || needsUpload}
        error={Boolean(searchError)}
        open={searchOpen && !searchError}
        onOpenChange={setSearchOpen}
        onSearch={(value) => {
          generation.current++
          setKeyword(value)
          if (!selecting.current) {
            setPeople([])
            setSelected(undefined)
          }
          selecting.current = false
          setError(null)
          setSearchError(null)
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
      {/* 错误移至搜索框上方，避免被下拉候选层遮挡。
      {error ? (
        <p role="alert" className="text-error">
          {error}
        </p>
      ) : null}
      {renderActions ? renderActions(inviteButton) : inviteButton}
      */}
      {renderActions ? renderActions(actionButton) : actionButton}
    </section>
  )
}
