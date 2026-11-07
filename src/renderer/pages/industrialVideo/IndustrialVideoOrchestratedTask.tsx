import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoAgentProduction from './IndustrialVideoAgentProduction'
import {
  advanceIndustrialVideoOrchestration,
  appendIndustrialVideoRevision,
  isIndustrialVideoOrchestrating,
  retryIndustrialVideoOrchestration
} from './industrialVideoOrchestration'
import IndustrialVideoTaskPanel from './IndustrialVideoTaskPanel'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

/**
 * 专用编排专用收件箱派生：从真实 job.progress 读取阶段/总镜数/已完成镜数。
 * 仅当字段为真实数字时才采用，绝不回退到任何硬编码或伪造的完成数。
 *   - stage: progress.stage 优先，否则回退 record.state（服务端权威状态）
 *   - totalShots: progress.total_scenes / progress.total，都没有则回退分镜脚本的真实场景数
 *   - doneShots: progress.scenes_done / progress.done；缺失则为 null（显示"进度待定"，不编造完成数）
 */
export interface IndustrialVideoLoadingProgress {
  stage: string
  totalShots: number | null
  doneShots: number | null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function deriveIndustrialVideoLoading(
  progress: Record<string, unknown> | undefined,
  recordState: string | undefined,
  fallbackTotalShots?: number | null
): IndustrialVideoLoadingProgress {
  const stage = typeof progress?.stage === 'string' ? progress.stage : (recordState ?? 'idle')
  const totalShots = readNumber(progress?.total_scenes) ?? readNumber(progress?.total) ?? fallbackTotalShots ?? null
  const doneShots = readNumber(progress?.scenes_done) ?? readNumber(progress?.done)
  return { stage, totalShots, doneShots }
}

/** 专用编排宿主：把普通消息流替换为专用工作台，否则原样放行（普通消息流）。 */
export function IndustrialVideoTaskSurface({
  sessionId,
  children,
  preview,
  previewOpen,
  filePreviewActive = false,
  onPreviewOpenChange
}: {
  sessionId: string
  children: ReactNode
  preview?: ReactNode
  previewOpen?: boolean
  filePreviewActive?: boolean
  onPreviewOpenChange?: (open: boolean) => void
}) {
  const [draft] = usePersistCache(`industrial_video.session_draft.${sessionId}`)
  return draft?.orchestration === 'dedicated' ? (
    <IndustrialVideoOrchestratedTask
      key={sessionId}
      sessionId={sessionId}
      messageFlow={children}
      preview={preview}
      previewOpen={previewOpen}
      filePreviewActive={filePreviewActive}></IndustrialVideoOrchestratedTask>
  ) : (
    // children
    <IndustrialVideoAgentProduction
      key={sessionId}
      sessionId={sessionId}
      previewOpen={previewOpen}
      filePreviewActive={filePreviewActive}
      onPreviewOpenChange={onPreviewOpenChange}>
      {children}
    </IndustrialVideoAgentProduction>
  )
}

/**
 * 专用编排底部输入分流：专用会话完全抑制普通 Agent 输入框（返回 null），
 * 专用修改输入由工作台宿主 IndustrialVideoOrchestratedTask 在消息流底部统一提供，
 * 避免同一修改同时进入普通聊天通道与专用编排收件箱造成双链竞争。
 */
export function IndustrialVideoTaskComposer({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [draft] = usePersistCache(`industrial_video.session_draft.${sessionId}`)
  return draft?.orchestration === 'dedicated' ? null : children
}

/** 非专用会话仍在底部展示 TaskPanel（文档/费用/文件由协作代理负责）；专用会话的 TaskPanel 改挂预览宿主。 */
export function IndustrialVideoLegacyPanel({ sessionId }: { sessionId: string }) {
  const [draft] = usePersistCache(`industrial_video.session_draft.${sessionId}`)
  return draft?.orchestration === 'dedicated' ? null : <IndustrialVideoTaskPanel sessionId={sessionId} />
}

/** 专用输入：只把修改意见写入专用编排收件箱并触发推进，绝不调用普通 Agent 发送通道。 */
function IndustrialVideoDedicatedInput({ sessionId, blocked }: { sessionId: string; blocked: boolean }) {
  const { t } = useTranslation()
  const draftKey = `industrial-video-revision-draft:${sessionId}`
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const send = async () => {
    const value = text.trim()
    if (!value || blocked || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const detail = { sessionId, text: value, submit: undefined as undefined | (() => Promise<void>) }
      window.dispatchEvent(new CustomEvent('industrial-video-submit-revision', { detail }))
      if (detail.submit) await detail.submit()
      else if (!appendIndustrialVideoRevision(sessionId, value)) throw new Error('修改未提交，草稿已保留。')
      setText('')
      localStorage.removeItem(draftKey)
      window.dispatchEvent(new CustomEvent('industrial-video-revision-draft', { detail: { sessionId, text: '' } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="border-t border-border bg-card p-3" data-ui="industrial-video.dedicated-composer">
      <textarea
        aria-label={t('industrial_video.composer.placeholder')}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          localStorage.setItem(draftKey, event.target.value)
          window.dispatchEvent(
            new CustomEvent('industrial-video-revision-draft', { detail: { sessionId, text: event.target.value } })
          )
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
        placeholder={t('industrial_video.composer.placeholder')}
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-xs text-muted-foreground" role="status">
        {blocked ? '本轮处理结束后可提交；当前输入仅保存为草稿，不会自动发送。' : '正在修改当前脚本与分镜'}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={() => void send()} disabled={blocked || busy || !text.trim()}>
          提交修改
        </Button>
      </div>
    </div>
  )
}

/** 拉取真实分镜脚本场景数，作为总镜数的权威回退（仅当 job.progress 未直接给出总镜数时）。 */
function useStoryboardShotCount(sessionId: string, run: string | null | undefined, state: string | undefined) {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!run) return
    if (!['planning', 'storyboard_submitted', 'confirming', 'generating', 'assembling', 'done'].includes(state ?? ''))
      return
    let stopped = false
    void ipcApi
      .request('industrial_video.storyboard_get', { sessionId, run, full: false })
      .then((response) => {
        if (stopped) return
        const board = (response as Record<string, unknown> | undefined)?.storyboard ?? response
        const scenes = (board as Record<string, unknown> | undefined)?.scenes
        if (Array.isArray(scenes)) setCount(scenes.length)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [sessionId, run, state])
  return count
}

/** 资料三步 + 视频阶段进度，置于消息流（review-message）内。 */
function IndustrialVideoProgress({
  preparationStage,
  state
}: {
  preparationStage: string | undefined
  state: string | undefined
}) {
  const { t } = useTranslation()
  const materialSteps = [
    {
      label: '理解资料',
      done: ['parsing', 'submitted', 'planning', 'planned'].includes(preparationStage ?? '')
    },
    {
      label: '核对关键依据',
      done: ['submitted', 'planning', 'planned'].includes(preparationStage ?? '')
    },
    {
      label: '生成脚本与分镜',
      done: ['storyboard_submitted', 'confirming', 'generating', 'assembling', 'done'].includes(state ?? '')
    }
  ]
  const videoSteps = [
    {
      label: '准备画面',
      done: ['assembling', 'done'].includes(state ?? '')
    },
    {
      label: '生成分镜',
      done: ['assembling', 'done'].includes(state ?? '')
    },
    {
      label: '配音与字幕',
      done: ['done'].includes(state ?? '')
    },
    {
      label: '拼接成片',
      done: ['done'].includes(state ?? '')
    }
  ]
  const renderStep = (step: { label: string; done: boolean }, index: number) => (
    <li key={step.label} className="flex items-center gap-3 text-sm">
      <span className="flex size-6 items-center justify-center rounded-full border border-border text-xs">
        {step.done ? '✓' : index + 1}
      </span>
      <span className={step.done ? 'text-muted-foreground line-through' : ''}>{step.label}</span>
    </li>
  )
  return (
    <section
      aria-label={t('industrial_video.workbench.progress')}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      data-ui="industrial-video.progress">
      <div>
        <h2 className="mb-3 font-medium">{t('industrial_video.workbench.material')}</h2>
        <ol className="space-y-3">{materialSteps.map(renderStep)}</ol>
      </div>
      <div>
        <h2 className="mb-3 font-medium">{t('industrial_video.workbench.video')}</h2>
        <ol className="space-y-3">{videoSteps.map(renderStep)}</ol>
      </div>
    </section>
  )
}

/** 右侧加载画面：真实阶段 + 真实总镜数，缺失完成数时显示"进度待定"，绝不伪造完成数。 */
function IndustrialVideoLoadingStage({
  loading,
  t
}: {
  loading: IndustrialVideoLoadingProgress
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const { stage, totalShots, doneShots } = loading
  const indeterminate = doneShots === null
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      data-ui="industrial-video.loading"
      data-stage={stage}
      data-total-shots={totalShots ?? ''}
      data-done-shots={doneShots ?? ''}>
      <svg viewBox="0 0 240 120" className="h-32 w-60 text-muted-foreground" aria-hidden="true">
        <path
          d="M15 100h210M40 100V45h65v55M115 100V65h85v35M55 45V25h30v20"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          d="M55 60h15v15H55zM80 60h15v15H80zM130 78h20v10h-20zM163 78h20v10h-20z"
          fill="currentColor"
          opacity=".25"
        />
        <circle
          cx="120"
          cy="40"
          r="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeDasharray="8 5"
          className="origin-[120px_40px] animate-spin motion-reduce:animate-none"
        />
      </svg>
      <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
      <p className="text-sm font-medium">
        {stage === 'assembling'
          ? '正在拼接成片'
          : stage === 'parsing'
            ? '正在理解资料'
            : stage === 'done'
              ? '成片已完成'
              : '正在生成视频'}
      </p>
      {totalShots !== null ? (
        indeterminate ? (
          <p className="text-xs text-muted-foreground">
            {t('industrial_video.workbench.loading_indeterminate', { total: totalShots })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('industrial_video.workbench.loading_shots', { done: doneShots ?? 0, total: totalShots })}
          </p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">{t('industrial_video.workbench.loading_unknown')}</p>
      )}
    </div>
  )
}

export default function IndustrialVideoOrchestratedTask({
  sessionId,
  messageFlow,
  preview,
  previewOpen,
  filePreviewActive = false
}: {
  sessionId: string
  messageFlow: ReactNode
  preview?: ReactNode
  previewOpen?: boolean
  filePreviewActive?: boolean
}) {
  const { t } = useTranslation()
  const [preparation] = usePersistCache(`industrial_video.preparation.${sessionId}`)
  const [draft] = usePersistCache(`industrial_video.session_draft.${sessionId}`)
  const [revisions] = usePersistCache(`industrial_video.revision.${sessionId}`)
  const production = useIndustrialVideoProduction(sessionId)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { refresh } = production
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refresh()
        if (stopped) return
        void advanceIndustrialVideoOrchestration(sessionId).catch((cause) => {
          if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
        })
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 3000)
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, refresh])
  const record = production.record
  const state = record?.state
  const progress = production.job?.progress as Record<string, unknown> | undefined
  const storyboardShots = useStoryboardShotCount(sessionId, record?.run ?? null, state)
  const loading = deriveIndustrialVideoLoading(progress, state, storyboardShots)
  const isGenerating = ['parsing', 'generating', 'assembling'].includes(state ?? '')
  const failure = error || production.error || preparation?.error || production.jobError
  const blocked = Boolean(production.record?.unknownSubmissions.length)
  // 受控成片预览：默认展开；收起时保留挂载（hidden），以免丢失编辑草稿且左侧 flex 铺满。
  // const open = previewOpen ?? true
  const open = (previewOpen ?? true) && !(state === 'done' && filePreviewActive)
  return (
    <div className="flex h-full min-h-0">
      {/* 消息流宿主：普通消息流 + 进度（资料三步 / 视频阶段） */}
      <div className="flex min-h-0 flex-1 flex-col" data-ui="industrial-video.review-message">
        <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messageFlow}
            {draft?.requirement && (
              <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-xl bg-muted px-4 py-3 text-sm">
                {draft.requirement}
              </p>
            )}
            {revisions?.revisions.map((revision) => (
              <div key={revision.id} className="ml-auto max-w-[85%] rounded-xl bg-muted px-4 py-3 text-sm">
                <p className="whitespace-pre-wrap">{revision.text}</p>
                {!revision.consumedRun && (
                  <p className="mt-1 text-xs text-muted-foreground">已收到，将在当前步骤结束后处理</p>
                )}
              </div>
            ))}
            <IndustrialVideoProgress preparationStage={preparation?.stage} state={state} />
            <div id={`industrial-video-review-${sessionId}`} />
            {preparation?.result && (
              <details className="text-sm">
                <summary>{t('industrial_video.orchestration.analysis')}</summary>
                <p className="whitespace-pre-wrap p-3">{preparation.result}</p>
              </details>
            )}
          </div>
        </div>
        <IndustrialVideoDedicatedInput
          key={sessionId}
          sessionId={sessionId}
          blocked={Boolean(
            failure ||
            blocked ||
            !['storyboard_submitted', 'confirming'].includes(state ?? '') ||
            preparation?.stage === 'planning' ||
            isIndustrialVideoOrchestrating(sessionId) ||
            revisions?.revisions.some((revision) => !revision.consumedRun)
          )}
        />
      </div>
      {/* 右侧产物预览宿主：生成中显示真实加载画面；其余阶段显示产物（TaskPanel 文件卡等）。
          MEA: 受控显隐——收起时用 hidden 而非 flex，避免 flex 样式覆盖导致仍占据布局。 */}
      <aside
        hidden={!open}
        className={open ? 'flex w-[380px] shrink-0 flex-col border-l border-border bg-card' : 'hidden'}
        aria-label="成片预览"
        data-ui="industrial-video.review-preview">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {isGenerating && <IndustrialVideoLoadingStage loading={loading} t={t} />}
          <div hidden={isGenerating} className="h-full">
            {preview}
          </div>
        </div>
        {failure && (
          <p role="alert" className="whitespace-pre-wrap break-words p-4 text-sm text-destructive">
            {failure}
          </p>
        )}
        {/* 技术信息默认折叠隐藏，仅错误详情（上方 alert）默认可见 */}
        {failure && (
          <details className="border-t border-border p-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('industrial_video.workbench.technical')}</summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify({ state, progress, run: record?.run }, null, 2)}
            </pre>
          </details>
        )}
        {preparation?.planningRun &&
          ['failed', 'planning'].includes(preparation.stage) &&
          !isIndustrialVideoOrchestrating(sessionId) && (
            <div className="border-t border-border p-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || blocked}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await retryIndustrialVideoOrchestration(sessionId)
                    await refresh()
                    setError('')
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  } finally {
                    setBusy(false)
                  }
                }}>
                {t('industrial_video.orchestration.retry')}
              </Button>
            </div>
          )}
      </aside>
    </div>
  )
}
