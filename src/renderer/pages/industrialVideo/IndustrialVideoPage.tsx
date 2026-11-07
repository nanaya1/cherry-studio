// MEA:industrial-video 为已创建任务提供本地参数交互。
// import { useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cacheService } from '@data/CacheService'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { CacheIndustrialVideoDraft } from '@shared/data/cache/cacheValueTypes'

import IndustrialVideoComposer from './IndustrialVideoComposer'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

// MEA:industrial-video 会话切换重建内存草稿并终止旧分析。
// 原入口仅接收已有 session；新建与重开共用同一个创建 surface。
export default function IndustrialVideoPage(props: {
  session?: AgentSessionEntity
  onDraftChange?: (draft: CacheIndustrialVideoDraft) => void
  ensureSession?: (draft: CacheIndustrialVideoDraft) => Promise<string>
  onSessionCreated?: (sessionId: string) => void
}) {
  return <IndustrialVideoSessionPage key={props.session?.id} {...props} />
}

function IndustrialVideoTaskProgress({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const [preparation] = usePersistCache(`industrial_video.preparation.${sessionId}`)
  if (!preparation) return null
  const { input, stage, result, error } = preparation
  const running = !['submitted', 'failed'].includes(stage)
  const labels = {
    uploading: 'industrial_video.preparation.uploading',
    analyzing: 'industrial_video.analyzing',
    parsing: 'industrial_video.preparation.parsing',
    submitted: 'industrial_video.preparation.submitted',
    planning: 'industrial_video.orchestration.storyboard',
    planned: 'industrial_video.orchestration.review',
    failed: 'industrial_video.material_failed'
  } as const
  return (
    <section className="mt-6 space-y-5" aria-label={t('industrial_video.title')}>
      <div className="ml-8 rounded-xl bg-muted p-4">
        <p className="whitespace-pre-wrap break-words">{input.requirement}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {input.attachments?.map((file) => (
            <span key={file.fileTokenSourceId} className="rounded-md border border-border px-2 py-1">
              {file.origin_name}
            </span>
          ))}
          {input.logo && (
            <span>
              {t('industrial_video.logo')}: {input.logo.name}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(input.settings.type === 'marketing' ? 'industrial_video.marketing' : 'industrial_video.assembly')}
          {' · '}
          {input.settings.duration} {t('industrial_video.seconds')}
          {' · '}
          {input.settings.ratio}
        </p>
      </div>
      <div className="rounded-xl border border-border bg-background p-4">
        <div role="status" aria-live="polite" className="flex items-center gap-2 font-medium">
          {running && <LoaderCircle aria-hidden="true" size={16} className="motion-safe:animate-spin" />}
          {t(labels[stage])}
        </div>
        {result && <p className="mt-3 whitespace-pre-wrap break-words text-sm">{result}</p>}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

function IndustrialVideoSessionPage({
  session,
  onDraftChange,
  ensureSession,
  onSessionCreated
}: {
  session?: AgentSessionEntity
  onDraftChange?: (draft: CacheIndustrialVideoDraft) => void
  ensureSession?: (draft: CacheIndustrialVideoDraft) => Promise<string>
  onSessionCreated?: (sessionId: string) => void
}) {
  const { t } = useTranslation()
  // MEA:industrial-video 制作设置仅恢复本地草稿，不伪装生产状态。
  const [settings, setSettings] = useState(
    () =>
      // 原整表读取：cacheService.getPersist('industrial_video.session_drafts')[session.id]?.settings
      (session ? cacheService.getPersist(`industrial_video.session_draft.${session.id}`)?.settings : undefined) ??
      createIndustrialVideoSettings('marketing')
  )

  // MEA:industrial-video 视频不覆盖普通入口的最近会话。
  // useEffect(() => {
  //   cacheService.setPersist('ui.agent.last_used_session_id', session.id)
  // }, [session.id])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      <main
        data-ui="industrial-video.workspace"
        className="flex min-h-[520px] flex-1 items-center justify-center px-6 pt-12 pb-[10vh]">
        <div data-composer-dock-layer="" className="w-full max-w-2xl">
          <div className="text-center">
            <h1 className="font-semibold text-2xl tracking-tight">
              {t(
                settings.type === 'marketing' ? 'industrial_video.create.marketing' : 'industrial_video.create.assembly'
              )}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                settings.type === 'marketing'
                  ? 'industrial_video.subtitle.marketing'
                  : 'industrial_video.subtitle.assembly'
              )}
            </p>
            {session?.name && <p className="mt-1 truncate text-xs text-muted-foreground">{session.name}</p>}
          </div>
          {session && <IndustrialVideoTaskProgress sessionId={session.id} />}
          <div className="mt-5 [&_[data-ui~='part:composer-input']]:min-h-24!">
            <IndustrialVideoComposer
              sessionId={session?.id}
              settings={settings}
              onSettingsChange={setSettings}
              onDraftChange={onDraftChange}
              ensureSession={ensureSession}
              onSessionCreated={onSessionCreated}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
