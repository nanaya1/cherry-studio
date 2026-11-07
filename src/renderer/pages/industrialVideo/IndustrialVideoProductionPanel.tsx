import { useEffect, useRef, useState } from 'react'

import { Button, Input, Textarea } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { Model } from '@shared/data/types/model'

import { buildIndustrialVideoSettingsParams, industrialVideoVoiceId } from './industrialVideoRequest'
import { buildIndustrialVideoPlanningKey, type IndustrialVideoSettings } from './industrialVideoSettings'
import { parseIndustrialStoryboard, prepareIndustrialStoryboard } from './industrialVideoWorkflow'
import { useIndustrialVideoAnalysis } from './useIndustrialVideoAnalysis'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

export default function IndustrialVideoProductionPanel({
  sessionId,
  model,
  settings,
  inputKey = ''
}: {
  sessionId: string
  model?: Model
  settings: IndustrialVideoSettings
  inputKey?: string
}) {
  const production = useIndustrialVideoProduction(sessionId)
  const analysis = useIndustrialVideoAnalysis()
  const refresh = production.refresh
  const [board, setBoard] = useState('')
  const [estimate, setEstimate] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const [artifact, setArtifact] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [sceneId, setSceneId] = useState('')
  const [reconcileJobId, setReconcileJobId] = useState('')
  const [reviewInput, setReviewInput] = useState<string | null>(null)
  // 设置生效回执（仅展示，不据此绕过服务端判定）。
  const [settingsReceipt, setSettingsReceipt] = useState<{
    effectiveSettings?: Record<string, unknown>
    requiresReplan?: boolean
    approvalInvalidated?: boolean
  } | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const mounted = useRef(true)
  const record = production.record
  const run = record?.run
  const pending = Boolean(record?.unknownSubmissions.length)
  const activeJob = Boolean(record?.jobId && ['parsing', 'generating', 'assembling', 'planning'].includes(record.state))

  // 规划比较 key：仅含会触发“新 run”的维度（input + 规划 key + 模型）。
  const planningKey = buildIndustrialVideoPlanningKey(settings)
  const reviewKey = JSON.stringify({ inputKey, planningKey, modelId: model?.id })
  // 费用失效比较：保留全部 settings，任一输出/音频设置变化都要重新预检。
  const currentInput = JSON.stringify({ inputKey, settings, modelId: model?.id })

  const execute = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (!mounted.current) return
      const status = (cause as { data?: { status?: unknown } })?.data?.status
      const message = cause instanceof Error ? cause.message : String(cause)
      // 409 设置版本冲突：不自动重发，提示刷新后重新预检。
      setError(status === 409 ? '设置版本冲突：未自动重发，请刷新状态后重新预检。' : message)
    } finally {
      if (mounted.current) {
        setBusy(false)
        await production.refresh()
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    setBoard('')
    setEstimate(null)
    setReport(null)
    setArtifact('')
    setSavedPath('')
    setReviewInput(null)
    setSettingsReceipt(null)
    setPreviewUrl('')
  }, [run])
  useEffect(() => {
    setEstimate(null)
    setSettingsReceipt(null)
  }, [currentInput, board])
  useEffect(() => {
    if (!activeJob || busy) return
    const timer = setTimeout(() => void refresh(), 3000)
    return () => clearTimeout(timer)
  }, [activeJob, busy, refresh, record?.updatedAt])
  // 成片路径来自 job 的 progress.final（按 doc 实际类型）。
  useEffect(() => {
    const job = production.job
    const progress = (job?.progress as Record<string, unknown> | undefined) ?? {}
    const finalPath = progress.final
    if (typeof finalPath === 'string' && finalPath && !artifact.trim()) {
      setArtifact(finalPath)
    }
  }, [production.job, artifact])

  if (!record) return production.error ? <p role="alert">{production.error}</p> : null

  /**
   * 生成参数：async 读取 planning_context_get，取得 effective_settings.settings_version
   * 或顶层 settings_version，作为 expectedSettingsVersion 随设置一起提交；版本未知停止提交。
   * 规划 key 变化（类型/时长/画幅/风格）时，旧的草稿确认已失效，必须创建新版本。
   */
  const params = async () => {
    if (!run) throw new Error('缺少制作版本。')
    if (reviewInput !== reviewKey) {
      throw new Error('需求、素材或规划设置已变化，请创建新版本并重新确认分镜。')
    }
    const context = await ipcApi.request('industrial_video.planning_context_get', {
      sessionId,
      run
    })
    const effective = (context?.effective_settings as Record<string, unknown> | undefined) ?? {}
    const rawVersion = context?.settings_version ?? effective?.settings_version
    const settingsVersion = typeof rawVersion === 'number' ? rawVersion : undefined
    if (typeof settingsVersion !== 'number') {
      throw new Error('无法获取服务端设置版本，已停止提交。请刷新状态后重新预检。')
    }
    return {
      sessionId,
      run,
      ...buildIndustrialVideoSettingsParams(settings, settingsVersion),
      ...(settings.voice === '无旁白' ? {} : { voice: industrialVideoVoiceId(settings.voice) }),
      aspectRatio: settings.ratio,
      style: settings.type === 'marketing' ? ('marketing' as const) : ('training' as const)
    }
  }
  return (
    <section aria-label="工业视频制作进度" className="mt-4 space-y-3 rounded-lg border p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          制作状态：{record.state} · {run ?? '尚未创建版本'}
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void production.refresh()}>
          刷新状态
        </Button>
      </div>
      {(error || production.error) && (
        <p role="alert" className="text-destructive">
          {error || production.error}
        </p>
      )}
      {pending && (
        <div className="space-y-2">
          <p role="alert">上次提交结果未知，已阻止重复提交。请查询任务并由服务端确认，不会自动重发。</p>
          <Input
            aria-label="待对账任务 ID"
            value={reconcileJobId}
            onChange={(event) => setReconcileJobId(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !reconcileJobId.trim()}
            onClick={() =>
              void execute(async () => {
                const job = await ipcApi.request('industrial_video.job_get', {
                  sessionId,
                  jobId: reconcileJobId.trim()
                })
                if (job.run !== run) throw new Error('该任务不属于当前制作版本，未恢复。')
                setReport(job)
              })
            }>
            确认任务归属并恢复
          </Button>
        </div>
      )}
      {production.job && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(production.job, null, 2)}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || pending || activeJob || !run || !record.jobId || !model}
          onClick={() =>
            void execute(async () => {
              const storyboard = await prepareIndustrialStoryboard(sessionId, run!, record.jobId!, async (context) => {
                const text = await analysis.analyze(
                  model!,
                  '你是工业视频分镜规划师。仅返回JSON对象，不要Markdown。必须包含video_title和非空scenes；每个场景包含唯一正整数id、title、正数duration、prompt及narration数组（start/end/text）。严格依据服务端规划上下文，不编造产品事实，遵循其中分镜约束。',
                  JSON.stringify({ context, settings })
                )
                if (!text) throw new Error('模型未返回有效分镜。')
                return text
              })
              if (mounted.current) {
                setBoard(JSON.stringify(storyboard, null, 2))
                setReviewInput(reviewKey)
              }
            })
          }>
          规划并提交分镜草稿
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !run}
          onClick={() =>
            void execute(async () => {
              const result = await ipcApi.request('industrial_video.storyboard_get', {
                sessionId,
                run: run!,
                full: true
              })
              const storyboard = parseIndustrialStoryboard(JSON.stringify(result.storyboard ?? result))
              {
                setBoard(JSON.stringify(storyboard, null, 2))
                setReviewInput(reviewKey)
              }
            })
          }>
          读取已存分镜
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !record.jobId}
          onClick={() =>
            void execute(async () => {
              await ipcApi.request('industrial_video.job_cancel', { sessionId, jobId: record.jobId! })
            })
          }>
          取消当前任务
        </Button>
        {pending && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                setReport(await ipcApi.request('industrial_video.job_list', { sessionId, limit: 30 }))
              })
            }>
            查询待对账任务
          </Button>
        )}
      </div>
      {board && (
        <>
          <label className="block space-y-1">
            分镜草稿（确认前请审阅）
            <Textarea.Input value={board} readOnly className="min-h-48 font-mono text-xs" />
          </label>
          <p className="text-muted-foreground">
            草稿提交不代表服务端已批准生成。输出设置通过公开 HTTP 提交，以服务端生效设置回执为准。
          </p>
          <Button
            size="sm"
            disabled={busy || pending || activeJob || !run}
            onClick={() =>
              void execute(async () => {
                // const result = await ipcApi.request('industrial_video.estimate', await params())
                const request = await params()
                const snapshot = await ipcApi.request('industrial_video.review_snapshot_get', {
                  sessionId,
                  run: run!,
                  reviewType: 'script_and_storyboard'
                })
                const receipt = await ipcApi.request('industrial_video.review_confirm', {
                  sessionId,
                  run: run!,
                  reviewType: 'script_and_storyboard',
                  expectedReviewVersion: snapshot.review_version
                })
                if (!receipt.generation_allowed || receipt.remaining_blockers.length)
                  throw new Error('审核尚有待处理事项，请重新编排后审核。')
                // setEstimate(result.estimate)
                setEstimate({ reviewVersion: receipt.review_version, settingsVersion: request.expectedSettingsVersion })
              })
            }>
            {/* 费用预检 */}
            确认脚本与分镜
          </Button>
          {estimate && (
            <div className="space-y-2">
              {/* <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(estimate, null, 2)}</pre> */}
              <p>本次生成可能产生费用，请确认后开始生成。</p>
              {settingsReceipt?.effectiveSettings && (
                <p className="text-muted-foreground">生效设置：{JSON.stringify(settingsReceipt.effectiveSettings)}</p>
              )}
              {settingsReceipt?.requiresReplan && (
                <p role="alert">服务端要求重新规划，请创建新版本并重新分镜，不能绕过服务端。</p>
              )}
              {settingsReceipt?.approvalInvalidated && (
                <p role="alert">之前的确认已被服务端判定失效，请重新确认，不能绕过服务端。</p>
              )}
              <Button
                disabled={busy || pending || activeJob}
                onClick={() =>
                  void execute(async () => {
                    const approved = estimate
                    setEstimate(null)
                    const request = await params()
                    if (request.expectedSettingsVersion !== approved.settingsVersion)
                      throw new Error('制作设置已变更，请重新审核。')
                    const current = await ipcApi.request('industrial_video.review_snapshot_get', {
                      sessionId,
                      run: run!,
                      reviewType: 'script_and_storyboard'
                    })
                    if (
                      current.review_version !== approved.reviewVersion ||
                      !current.generation_allowed ||
                      current.remaining_blockers.length
                    )
                      throw new Error('审核内容已变更，请重新审核。')
                    const result = await ipcApi.request('industrial_video.video_start', request)
                    setSettingsReceipt({
                      effectiveSettings: result.effectiveSettings ?? undefined,
                      requiresReplan: result.requiresReplan,
                      approvalInvalidated: result.approvalInvalidated
                    })
                    setEstimate(null)
                  })
                }>
                {/* 确认分镜与费用，开始生成（可能计费） */}
                确认开始生成（可能计费）
              </Button>
            </div>
          )}
        </>
      )}
      {!estimate && settingsReceipt?.effectiveSettings && (
        <p className="text-muted-foreground">生效设置：{JSON.stringify(settingsReceipt.effectiveSettings)}</p>
      )}
      {!estimate && settingsReceipt?.requiresReplan && <p role="alert">服务端要求重新规划，请重新准备分镜。</p>}
      {!estimate && settingsReceipt?.approvalInvalidated && <p role="alert">服务端已使之前的生成批准失效。</p>}
      {run && (
        <div className="space-y-2 border-t pt-3">
          {/* 状态提示：review_only / blocked / final_stale / report_stale 仅展示，不禁止下载。 */}
          {production.job?.status === 'blocked' && (
            <p role="alert">blocked：任务被服务端阻塞，需先处理待办事项后再继续。</p>
          )}
          {(production.job as { progress?: { final_stale?: boolean } } | null)?.progress?.final_stale && (
            <p role="alert">final_stale：当前成片是历史版本，不代表当前版本已完成。</p>
          )}
          {report?.review_only === true && (
            <p role="alert">review_only：成片仅供自审，未经人工审核通过，不得对外交付。</p>
          )}
          {report?.report_stale === true && (
            <p role="alert">report_stale：质检报告已过期，需重新获取后再判断交付状态。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || activeJob || pending}
              onClick={() =>
                void execute(async () => {
                  setReport(await ipcApi.request('industrial_video.qa_get', { sessionId, run }))
                })
              }>
              质量与失败场景
            </Button>
            <label>
              失败场景 ID{' '}
              <Input
                aria-label="失败场景 ID"
                type="number"
                min="1"
                value={sceneId}
                className="w-20 rounded border bg-background px-2 py-1"
                onChange={(event) => setSceneId(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || activeJob || pending || !Number.isInteger(Number(sceneId)) || Number(sceneId) < 1}
              onClick={() =>
                void execute(async () => {
                  setReport(
                    await ipcApi.request('industrial_video.scene_retry', { sessionId, run, sceneId: Number(sceneId) })
                  )
                })
              }>
              重试指定失败场景（可能计费）
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || activeJob || pending}
              onClick={() =>
                void execute(async () => {
                  await ipcApi.request('industrial_video.assemble', { sessionId, run })
                })
              }>
              复用片段重新合成
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || activeJob}
              onClick={() =>
                void execute(async () => {
                  const preview = await ipcApi.request('industrial_video.preview_create', { sessionId, run })
                  setReport(preview)
                  const url = preview?.preview_url
                  if (typeof url === 'string' && /^https?:\/\//i.test(url)) setPreviewUrl(url)
                })
              }>
              读取预览产物信息
            </Button>
          </div>
          {previewUrl && (
            <p className="break-all">
              网页预览：
              <a href={previewUrl} target="_blank" rel="noreferrer">
                预览网页
              </a>
              （仅供浏览器打开，非 video src）
            </p>
          )}
          {report && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(report, null, 2)}</pre>
          )}
          <label className="block">
            服务端返回的成片路径
            <Input
              aria-label="成片路径"
              value={artifact}
              onChange={(event) => setArtifact(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-2 py-1"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !artifact.trim()}
            onClick={() =>
              void execute(async () => {
                const result = await ipcApi.request('industrial_video.download_artifact', {
                  sessionId,
                  run,
                  path: artifact.trim()
                })
                setSavedPath(result.filePath)
              })
            }>
            下载至任务工作目录
          </Button>
          {savedPath && <p className="break-all">已保存：{savedPath}</p>}
        </div>
      )}
    </section>
  )
}
