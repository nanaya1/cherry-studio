import { Check, Copy, Edit3, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuidv4 } from 'uuid'

import { Button, Input, Switch, Tooltip } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import Scrollbar from '@renderer/components/Scrollbar'
import { useProviderApiKeys, useProviderMutations } from '@renderer/hooks/useProvider'
import { toast } from '@renderer/services/toast'
import { maskApiKey } from '@renderer/utils/api'
import type { ApiKeyEntry } from '@shared/data/types/provider'

import ProviderSettingsDrawer from '../primitives/ProviderSettingsDrawer'
import { apiKeyListClasses } from '../primitives/ProviderSettingsPrimitives'
import { copyApiKeyToClipboard } from './copyApiKeyToClipboard'

interface ProviderApiKeyListDrawerProps {
  providerId: string
  open: boolean
  onClose: () => void
  managed?: ManagedApiKeyListOptions
}

export interface ManagedApiKeyListOptions {
  visible: boolean
  emptyMessage: string
  errorMessage: string
}

interface DraftState {
  id: string
  key: string
  label: string
  isNew: boolean
}

const createEmptyDraft = (): DraftState => ({
  id: uuidv4(),
  key: '',
  label: '',
  isNew: true
})

const logger = loggerService.withContext('ProviderApiKeyListDrawer')

function normalizeApiKeyValue(value: string) {
  return value.trim()
}

function toDraft(entry: ApiKeyEntry): DraftState {
  return {
    id: entry.id,
    key: entry.key,
    label: entry.label ?? '',
    isNew: false
  }
}

export function getManagedApiKeys(keys: ApiKeyEntry[] | undefined, visible: boolean) {
  return visible ? (keys ?? []).filter((key) => !('revoked' in key && key.revoked)) : []
}

export function displayManagedApiKey(key: string) {
  return /^(?:\*{4,}|.{2}\*{4}.{4})$/.test(key) ? key : '****'
}

export default function ProviderApiKeyListDrawer({
  providerId,
  open,
  onClose,
  managed
}: ProviderApiKeyListDrawerProps) {
  const { t } = useTranslation()
  const { data } = useProviderApiKeys(providerId)
  const keys = managed ? getManagedApiKeys(data?.keys, managed.visible) : (data?.keys ?? [])
  return (
    <ProviderSettingsDrawer
      open={open}
      onClose={onClose}
      title={t('settings.provider.api.key.list.title')}
      description={t('settings.provider.api_key.list_description')}
      footer={
        <div className={apiKeyListClasses.summaryMeta}>
          {keys.filter((key) => key.isEnabled).length} / {keys.length} {t('settings.provider.api_key.enabled_suffix')}
        </div>
      }>
      <ProviderApiKeyList providerId={providerId} open={open} managed={managed} />
    </ProviderSettingsDrawer>
  )
}

function ProviderApiKeyList({
  providerId,
  open = true,
  managed
}: {
  providerId: string
  open?: boolean
  managed?: ManagedApiKeyListOptions
}) {
  const { t } = useTranslation()
  const { data: apiKeysData, isLoading, error } = useProviderApiKeys(providerId)
  const { addApiKey, updateApiKey, deleteApiKey } = useProviderMutations(providerId)
  const isManaged = managed !== undefined
  const visible = managed?.visible ?? true
  const apiKeys = useMemo(() => {
    return isManaged ? getManagedApiKeys(apiKeysData?.keys, visible) : (apiKeysData?.keys ?? [])
  }, [apiKeysData?.keys, isManaged, visible])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setDraft(null)
    }
  }, [open])

  const persist = useCallback(
    async (mutation: () => Promise<void>) => {
      if (savingRef.current) {
        return false
      }

      savingRef.current = true
      setSaving(true)
      try {
        await mutation()
        return true
      } catch (error) {
        logger.error('Failed to persist provider API keys', { providerId, error })
        toast.error(t('settings.provider.api_key.save_failed'))
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [providerId, t]
  )

  const validateDraft = useCallback(
    (nextDraft: DraftState) => {
      const key = normalizeApiKeyValue(nextDraft.key)
      if (!key) {
        toast.warning(t('settings.provider.api.key.error.empty'))
        return null
      }

      const isDuplicate = apiKeys.some((item) => item.id !== nextDraft.id && item.key.trim() === key)
      if (isDuplicate) {
        toast.warning(t('settings.provider.api.key.error.duplicate'))
        return null
      }

      return key
    },
    [apiKeys, t]
  )

  const startAdd = useCallback(() => {
    const nextDraft = createEmptyDraft()
    setEditingId(nextDraft.id)
    setDraft(nextDraft)
  }, [])

  const startEdit = useCallback((entry: ApiKeyEntry) => {
    const nextDraft = toDraft(entry)
    setEditingId(nextDraft.id)
    setDraft(nextDraft)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setDraft(null)
  }, [])

  const saveDraft = useCallback(async () => {
    if (!draft) {
      return
    }

    const key = validateDraft(draft)
    if (!key) {
      return
    }

    const label = draft.label.trim()
    const saved = await persist(() =>
      draft.isNew ? addApiKey(key, label || undefined) : updateApiKey(draft.id, { key, label })
    )
    if (saved) {
      cancelEdit()
    }
  }, [addApiKey, cancelEdit, draft, persist, updateApiKey, validateDraft])

  const removeKey = useCallback(
    async (id: string) => {
      if ((await persist(() => deleteApiKey(id))) && editingId === id) {
        cancelEdit()
      }
    },
    [cancelEdit, deleteApiKey, editingId, persist]
  )

  const toggleEnabled = useCallback(
    async (entry: ApiKeyEntry, isEnabled: boolean) => {
      await persist(() => updateApiKey(entry.id, { isEnabled }))
    },
    [persist, updateApiKey]
  )

  return (
    <div className="space-y-4">
      <div className={apiKeyListClasses.listWrap}>
        <Scrollbar className={apiKeyListClasses.listScroller}>
          {apiKeys.length === 0 && (isManaged || !draft) ? (
            <div
              className="px-4 py-6 text-center text-muted-foreground text-sm"
              role={managed && error ? 'alert' : undefined}>
              {managed
                ? isLoading
                  ? t('common.loading')
                  : error
                    ? managed.errorMessage
                    : managed.emptyMessage
                : t('error.no_api_key')}
            </div>
          ) : null}
          {apiKeys.map((entry, index) => (
            <div key={entry.id} className={apiKeyListClasses.keyRow}>
              {!isManaged && editingId === entry.id && draft ? (
                <ApiKeyDraftRow
                  draft={draft}
                  saving={saving}
                  onChange={setDraft}
                  onSave={saveDraft}
                  onCancel={cancelEdit}
                />
              ) : (
                <ApiKeyDisplayRow
                  entry={entry}
                  saving={saving}
                  managedLabel={
                    isManaged ? `${entry.label || t('settings.provider.api_key.unnamed')} ${index + 1}` : undefined
                  }
                  onEdit={isManaged ? undefined : () => startEdit(entry)}
                  onRemove={isManaged ? undefined : () => void removeKey(entry.id)}
                  onToggleEnabled={(next) => void toggleEnabled(entry, next)}
                />
              )}
            </div>
          ))}
          {!isManaged && draft?.isNew ? (
            <div className={apiKeyListClasses.keyRow}>
              <ApiKeyDraftRow
                draft={draft}
                saving={saving}
                onChange={setDraft}
                onSave={saveDraft}
                onCancel={cancelEdit}
              />
            </div>
          ) : null}
        </Scrollbar>
      </div>

      {!isManaged && (
        <Button className="w-full" variant="secondary" size="sm" disabled={!!draft || saving} onClick={startAdd}>
          <Plus size={14} />
          {t('settings.provider.api_setup.add_key')}
        </Button>
      )}
    </div>
  )
}

interface ApiKeyDraftRowProps {
  draft: DraftState
  saving: boolean
  onChange: (draft: DraftState) => void
  onSave: () => void | Promise<void>
  onCancel: () => void
}

function ApiKeyDraftRow({ draft, saving, onChange, onSave, onCancel }: ApiKeyDraftRowProps) {
  const { t } = useTranslation()

  return (
    <div className={apiKeyListClasses.keyDraftRow}>
      <div className={apiKeyListClasses.keyDraftInputs}>
        <Input
          value={draft.label}
          placeholder={t('settings.provider.api_key.label_placeholder')}
          className={apiKeyListClasses.keyDraftInput}
          disabled={saving}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
        <Input
          value={draft.key}
          placeholder={t('settings.provider.api.key.new_key.placeholder')}
          className={apiKeyListClasses.keyDraftInput}
          disabled={saving}
          spellCheck={false}
          autoFocus
          onChange={(event) => onChange({ ...draft, key: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void onSave()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
        />
      </div>
      <div className={apiKeyListClasses.keyRowActions}>
        <Tooltip content={t('common.save')}>
          <button
            type="button"
            className={apiKeyListClasses.keySaveIconButton}
            aria-label={t('common.save')}
            disabled={saving}
            onClick={onSave}>
            <Check />
          </button>
        </Tooltip>
        <Tooltip content={t('common.cancel')}>
          <button
            type="button"
            className={apiKeyListClasses.keyDestructiveIconButton}
            aria-label={t('common.cancel')}
            disabled={saving}
            onClick={onCancel}>
            <X />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

interface ApiKeyDisplayRowProps {
  entry: ApiKeyEntry
  saving: boolean
  managedLabel?: string
  onEdit?: () => void
  onRemove?: () => void
  onToggleEnabled: (enabled: boolean) => void
}

function ApiKeyDisplayRow({ entry, saving, managedLabel, onEdit, onRemove, onToggleEnabled }: ApiKeyDisplayRowProps) {
  const { t } = useTranslation()
  const maskedKey = maskApiKey(entry.key)
  const handleCopy = useCallback(() => {
    void copyApiKeyToClipboard(entry.key, t)
  }, [entry.key, t])

  return (
    <div className={apiKeyListClasses.keyDisplayRow}>
      <div className={apiKeyListClasses.keyTextBlock}>
        {managedLabel || entry.label ? (
          <div className={apiKeyListClasses.keyLabel}>{managedLabel ?? entry.label}</div>
        ) : null}
        {managedLabel ? (
          <>
            <span className={`${apiKeyListClasses.keyValue} select-none`} onCopy={(event) => event.preventDefault()}>
              {displayManagedApiKey(entry.key)}
            </span>
            {Object.entries(entry.managedRoutes?.endpointConfigs ?? {}).map(([protocol, config]) => (
              <p key={protocol} className="break-all text-xs text-muted-foreground">
                {protocol} · {t('settings.provider.api_host')}: {config?.baseUrl || '—'}
              </p>
            ))}
          </>
        ) : (
          <button
            type="button"
            title={t('settings.provider.api_key.copy')}
            className={`${apiKeyListClasses.keyValue} block cursor-pointer text-left transition-colors hover:text-foreground`}
            onClick={handleCopy}>
            {maskedKey === entry.key ? '••••••••' : maskedKey}
          </button>
        )}
      </div>
      <div className={apiKeyListClasses.keyRowActions}>
        {!managedLabel && (
          <Tooltip content={t('settings.provider.api_key.copy')}>
            <button
              type="button"
              className={apiKeyListClasses.keyIconButton}
              aria-label={t('settings.provider.api_key.copy')}
              disabled={saving}
              onClick={handleCopy}>
              <Copy />
            </button>
          </Tooltip>
        )}
        {onEdit && (
          <Tooltip content={t('common.edit')}>
            <button
              type="button"
              className={apiKeyListClasses.keyIconButton}
              aria-label={t('common.edit')}
              disabled={saving}
              onClick={onEdit}>
              <Edit3 />
            </button>
          </Tooltip>
        )}
        {onRemove && (
          <Tooltip content={t('common.delete')}>
            <button
              type="button"
              className={apiKeyListClasses.keyDestructiveIconButton}
              aria-label={t('common.delete')}
              disabled={saving}
              onClick={onRemove}>
              <Trash2 />
            </button>
          </Tooltip>
        )}
        <Switch
          size="xs"
          aria-label={managedLabel}
          checked={entry.isEnabled}
          disabled={saving}
          onCheckedChange={onToggleEnabled}
        />
      </div>
    </div>
  )
}
