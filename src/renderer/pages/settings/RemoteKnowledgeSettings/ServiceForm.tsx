import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '@cherrystudio/ui'
import type {
  CreateRemoteKnowledgeServiceDto,
  RemoteAuthType,
  RemoteKnowledgeServiceInfo,
  RemoteTestConnectionResult
} from '@shared/data/types/remoteKnowledge'

interface ServiceFormProps {
  open: boolean
  service?: RemoteKnowledgeServiceInfo
  busy: boolean
  onOpenChange: (open: boolean) => void
  onTest: (input: { id: string } | { config: CreateRemoteKnowledgeServiceDto }) => Promise<RemoteTestConnectionResult>
  onSave: (draft: CreateRemoteKnowledgeServiceDto) => Promise<void>
}

function parseHeaders(value: string): Record<string, string> | undefined {
  const entries = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator < 1) throw new Error('headers')
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const
    })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function serializeHeaders(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

export function ServiceForm({ open, service, busy, onOpenChange, onTest, onSave }: ServiceFormProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [authType, setAuthType] = useState<RemoteAuthType>('bearer')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('30000')
  const [enabled, setEnabled] = useState(true)
  const [result, setResult] = useState<RemoteTestConnectionResult>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setName(service?.name ?? '')
    setBaseUrl(service?.baseUrl ?? '')
    setAuthType(service?.authType ?? 'bearer')
    setApiKey('')
    setHeadersText(serializeHeaders(service?.headers))
    setTimeoutMs(String(service?.timeoutMs ?? 30_000))
    setEnabled(service?.enabled ?? true)
    setResult(undefined)
    setError(undefined)
  }, [open, service])

  const draft = useMemo<CreateRemoteKnowledgeServiceDto | undefined>(() => {
    try {
      const trimmedName = name.trim()
      const trimmedUrl = baseUrl.trim()
      const timeout = Number(timeoutMs)
      if (!trimmedName || !trimmedUrl || !Number.isInteger(timeout) || timeout < 1000 || timeout > 300_000) return
      return {
        name: trimmedName,
        baseUrl: trimmedUrl,
        authType,
        ...(apiKey ? { apiKey } : {}),
        ...(parseHeaders(headersText) ? { headers: parseHeaders(headersText) } : {}),
        timeoutMs: timeout,
        enabled
      }
    } catch {
      return
    }
  }, [apiKey, authType, baseUrl, enabled, headersText, name, timeoutMs])

  const handleTest = async () => {
    if (!draft) {
      setError(t('settings.remoteKnowledge.form.invalid'))
      return false
    }
    setError(undefined)
    try {
      const nextResult = await onTest(service && !apiKey ? { id: service.id } : { config: draft })
      setResult(nextResult)
      if (!nextResult.ok) setError(nextResult.error ?? t('settings.remoteKnowledge.testConnection.failed'))
      return nextResult.ok
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }

  const handleTestAndSave = async () => {
    if (!(await handleTest()) || !draft) return
    await onSave(draft)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-xl" closeOnOverlayClick={!busy}>
        <DialogHeader>
          <DialogTitle>{service ? t('settings.remoteKnowledge.edit') : t('settings.remoteKnowledge.add')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="remote-knowledge-name">{t('settings.remoteKnowledge.name')}</Label>
              <Input id="remote-knowledge-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('settings.remoteKnowledge.authType')}</Label>
              <Select value={authType} onValueChange={(value) => setAuthType(value as RemoteAuthType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">{t('settings.remoteKnowledge.authType.bearer')}</SelectItem>
                  <SelectItem value="api_key">{t('settings.remoteKnowledge.authType.api_key')}</SelectItem>
                  <SelectItem value="oauth2" disabled>
                    {t('settings.remoteKnowledge.authType.oauth2.unsupported')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remote-knowledge-url">{t('settings.remoteKnowledge.baseUrl')}</Label>
            <Input
              id="remote-knowledge-url"
              value={baseUrl}
              placeholder="https://knowledge.example.com"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remote-knowledge-key">API Key</Label>
            <Input
              id="remote-knowledge-key"
              type="password"
              value={apiKey}
              placeholder={
                service?.hasApiKey
                  ? t('settings.remoteKnowledge.apiKey.keepExisting')
                  : t('settings.remoteKnowledge.apiKey.placeholder')
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remote-knowledge-headers">{t('settings.remoteKnowledge.headers')}</Label>
            <Textarea.Input
              id="remote-knowledge-headers"
              className="min-h-20 font-mono text-xs"
              value={headersText}
              placeholder="X-Tenant-ID: tenant-1"
              onValueChange={setHeadersText}
            />
            <p className="m-0 text-[11px] text-muted-foreground">{t('settings.remoteKnowledge.headers.help')}</p>
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="remote-knowledge-timeout">{t('settings.remoteKnowledge.timeout')}</Label>
              <Input
                id="remote-knowledge-timeout"
                type="number"
                min={1000}
                max={300000}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.value)}
              />
            </div>
            <div className="flex h-9 items-center justify-between rounded-md border border-border px-3">
              <Label htmlFor="remote-knowledge-enabled">{t('settings.remoteKnowledge.enabled')}</Label>
              <Switch id="remote-knowledge-enabled" size="sm" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
          {(error || result?.ok) && (
            <div className={result?.ok ? 'text-xs text-status-success' : 'text-xs text-destructive'} role="status">
              {result?.ok ? t('settings.remoteKnowledge.testConnection.ok', { latency: result.latencyMs ?? 0 }) : error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={handleTest}>
            {t('settings.remoteKnowledge.testConnection')}
          </Button>
          <Button disabled={busy || !draft} onClick={handleTestAndSave}>
            {t('settings.remoteKnowledge.testAndSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
