import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import { Button, CodeEditor } from '@cherrystudio/ui'
import { FilePreview } from '@renderer/components/FilePreview'
import { useSession } from '@renderer/hooks/agent/useSession'
import { useFileEditSession } from '@renderer/hooks/useFileEditSession'
import { ipcApi } from '@renderer/ipc'
import { normalizeFilePreviewPath } from '@renderer/utils/filePreview'
import { joinPath } from '@renderer/utils/path'
import type { industrialVideoReviewDocumentsSchema } from '@shared/ipc/schemas/industrialVideo'
import type { AbsoluteFilePath } from '@shared/types/file'
import { createFilePathHandle } from '@shared/utils/file'

import IndustrialVideoOnlinePreview from './IndustrialVideoOnlinePreview'
import { appendIndustrialVideoRevision } from './industrialVideoOrchestration'
import type { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

type Snapshot = z.infer<typeof industrialVideoReviewDocumentsSchema>
type Production = ReturnType<typeof useIndustrialVideoProduction>
type DocumentKind = 'script' | 'storyboard'
/* 停用费用预估展示，保留以便恢复。
const estimateFields = {
  total_cost: '预计总费用',
  estimated_cost: '预计费用',
  total: '合计',
  cost: '费用',
  currency: '币种',
  duration: '预计时长（秒）',
  duration_s: '预计时长（秒）',
  estimated_duration_s: '预计时长（秒）'
} as const
*/

function storyboardDocument(board: Snapshot['storyboard']) {
  if (!Array.isArray(board.scenes)) throw new Error('分镜内容不完整，请重新编排。')
  // JSON 是唯一可编辑数据源，保留提示词、旁白数组和扩展字段。
  const json = JSON.stringify(board, null, 2)
  const fence = '`'.repeat(Math.max(3, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length + 1)))
  return {
    text: `# 分镜脚本\n\n请在 JSON 代码块中编辑，保留未修改的字段和旁白时间。\n\n${fence}json\n${json}\n${fence}\n`
  }
}

function applyStoryboardDocument(text: string) {
  const match = text.match(/^(`{3,})json\r?\n([\s\S]*?)\r?\n\1\s*$/m)
  if (!match) throw new Error('请保留完整的分镜 JSON 代码块。')
  return z
    .object({ video_title: z.string().min(1), scenes: z.array(z.record(z.string(), z.unknown())) })
    .passthrough()
    .parse(JSON.parse(match[2]))
}

export default function DedicatedIndustrialVideoReview({
  sessionId,
  production
}: {
  sessionId: string
  production: Production
}) {
  const { session } = useSession(sessionId)
  const workspace = session?.workspace?.path
  const run = production.record?.run
  return (
    <DedicatedReview
      key={`${sessionId}:${run ?? ''}`}
      sessionId={sessionId}
      workspace={workspace}
      production={production}
    />
  )
}

function DedicatedReview({
  sessionId,
  workspace,
  production
}: {
  sessionId: string
  workspace?: string
  production: Production
}) {
  const { t } = useTranslation()
  const run = production.record?.run
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [paths, setPaths] = useState<{ script: AbsoluteFilePath; storyboard: AbsoluteFilePath } | null>(null)
  const [selected, setSelected] = useState<DocumentKind>('script')
  const [editing, setEditing] = useState(false)
  const [revisionDraft, setRevisionDraft] = useState(
    () => localStorage.getItem(`industrial-video-revision-draft:${sessionId}`) ?? ''
  )
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail
      if (detail.sessionId === sessionId) setRevisionDraft(detail.text)
    }
    window.addEventListener('industrial-video-revision-draft', update)
    return () => window.removeEventListener('industrial-video-revision-draft', update)
  }, [sessionId])
  const draftKey = `industrial-video-script-draft:${sessionId}:${run ?? ''}`
  const boardDraftKey = `industrial-video-board-draft:${sessionId}:${run ?? ''}`
  const [scriptChanged, setScriptChanged] = useState(() => localStorage.getItem(draftKey) !== null)
  const [boardChanged, setBoardChanged] = useState(() => localStorage.getItem(boardDraftKey) !== null)
  const [submittedScript, setSubmittedScript] = useState<string | null>(null)
  const submittedDraft = useRef<{ script: string; board: string } | null>(null)
  const [approval, setApproval] = useState<{
    // value: Record<string, unknown>
    settingsVersion?: number
    reviewVersion: string
  } | null>(null)
  const [video, setVideo] = useState<AbsoluteFilePath | null>(null)
  const [previewVideo, setPreviewVideo] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const lock = useRef(false)
  const alive = useRef(true)
  const loaded = useRef<string | null>(null)
  const reviewAvailable =
    production.record?.state === 'storyboard_submitted' || production.record?.state === 'confirming'
  const sourceVersion = `${production.record?.version ?? ''}`
  // const downloaded = useRef('')
  const path = paths?.[selected]
  const handle = useMemo(() => (path ? createFilePathHandle(path) : undefined), [path])
  const file = useFileEditSession(handle)
  const dirty = useRef(false)
  dirty.current = scriptChanged || boardChanged || file.isDirty || file.conflict || Boolean(file.saveError)
  const attempted = useRef('')
  const executionBlocked =
    !reviewAvailable ||
    Boolean(production.error) ||
    Boolean(production.record?.unknownSubmissions.length) ||
    ['queued', 'running'].includes(String(production.job?.status ?? ''))
  const blocked =
    executionBlocked ||
    Boolean(revisionDraft.trim()) ||
    submittedScript !== null ||
    busy ||
    !snapshot ||
    !paths ||
    file.conflict ||
    Boolean(file.error || file.saveError) ||
    loaded.current !== sourceVersion ||
    scriptChanged ||
    boardChanged ||
    Boolean(production.error) ||
    Boolean(production.record?.unknownSubmissions.length)

  useEffect(() => {
    alive.current = true
    const findHost = () => setHost(document.getElementById(`industrial-video-review-${sessionId}`))
    findHost()
    const observer = new MutationObserver(findHost)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      alive.current = false
      observer.disconnect()
    }
  }, [sessionId])

  const execute = useCallback(async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (alive.current) {
        setApproval(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }, [])

  const readSnapshot = useCallback(
    async (acceptSubmittedBoard = false) => {
      const canReconcileScript =
        submittedScript !== null &&
        loaded.current !== sourceVersion &&
        (!boardChanged || submittedDraft.current !== null) &&
        !file.isDirty &&
        !file.conflict
      if (dirty.current && !acceptSubmittedBoard && !canReconcileScript && paths) {
        setApproval(null)
        throw new Error('已保留本地草稿；请先按本地脚本重新编排或提交分镜修改，再刷新审核。')
      }
      if (!run || !workspace) throw new Error('请先创建制作任务并选择工作区。')
      const result = await ipcApi.request('industrial_video.review_snapshot_get', {
        sessionId,
        run,
        reviewType: 'script_and_storyboard'
      })
      if (!('script' in result) || typeof result.script !== 'string' || !('storyboard' in result))
        throw new Error('审核文档尚未就绪，请稍后刷新。')
      const documents = result as Snapshot
      if (!alive.current) return
      if (canReconcileScript) {
        const local = await window.api.fs.readText(paths!.script)
        if (
          submittedDraft.current &&
          (await window.api.fs.readText(paths!.storyboard)) !== submittedDraft.current.board
        )
          throw new Error('提交后分镜又有编辑，已保留草稿，请先处理新修改。')
        if (local !== submittedScript || (!submittedDraft.current && documents.script !== submittedScript))
          throw new Error('重新编排尚未采用当前脚本，已保留本地草稿，请稍后刷新审核。')
      } else if (dirty.current && !acceptSubmittedBoard && paths) return
      // 每次快照生成独立文件，绝不覆盖用户已经编辑的本地草稿。
      const stem = `审核-${crypto.randomUUID()}-`
      const script = normalizeFilePreviewPath(joinPath(workspace, `${stem}脚本.md`))
      const storyboard = normalizeFilePreviewPath(joinPath(workspace, `${stem}分镜脚本.md`))
      if (!script || !storyboard) throw new Error('工作区路径无效。')
      const savedDraft = localStorage.getItem(draftKey)
      await window.api.file.write(script, !paths && savedDraft !== null ? savedDraft : documents.script)
      await window.api.file.write(
        storyboard,
        !paths && localStorage.getItem(boardDraftKey) !== null
          ? localStorage.getItem(boardDraftKey)!
          : storyboardDocument(documents.storyboard).text
      )
      if (!alive.current) return
      if (dirty.current && !acceptSubmittedBoard && !canReconcileScript && paths) return
      if (canReconcileScript) {
        localStorage.removeItem(draftKey)
        localStorage.removeItem(boardDraftKey)
        submittedDraft.current = null
        setScriptChanged(false)
        setSubmittedScript(null)
      }
      loaded.current = sourceVersion
      setPaths({ script, storyboard })
      setSnapshot(documents)
      setApproval(null)
      if (acceptSubmittedBoard) localStorage.removeItem(boardDraftKey)
      setBoardChanged(localStorage.getItem(boardDraftKey) !== null)
      setEditing(false)
    },
    [
      sessionId,
      run,
      workspace,
      paths,
      sourceVersion,
      submittedScript,
      boardChanged,
      file.isDirty,
      file.conflict,
      draftKey,
      boardDraftKey
    ]
  )

  useEffect(() => {
    if (!run || !workspace || !reviewAvailable || busy || (paths && dirty.current && !submittedScript)) return
    if (loaded.current === sourceVersion || attempted.current === sourceVersion) return
    attempted.current = sourceVersion
    void execute(() => readSnapshot())
  }, [
    run,
    workspace,
    reviewAvailable,
    sourceVersion,
    busy,
    paths,
    submittedScript,
    scriptChanged,
    boardChanged,
    execute,
    readSnapshot
  ])

  useEffect(() => {
    const submit = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string
          text: string
          submit?: () => Promise<void>
        }>
      ).detail
      if (detail.sessionId !== sessionId) return
      detail.submit = async () => {
        if (executionBlocked || lock.current || !paths || !snapshot)
          throw new Error('当前版本尚不可修改，输入草稿已保留。')
        await file.flush()
        const script = await window.api.fs.readText(paths.script)
        const board = await window.api.fs.readText(paths.storyboard)
        const revision = appendIndustrialVideoRevision(
          sessionId,
          `${detail.text}\n\n以当前人工编辑的分镜为基准，保留未要求修改的字段：\n${board}`,
          script
        )
        if (!revision) throw new Error('修改未提交，草稿已保留。')
        submittedDraft.current = { script, board }
        setSubmittedScript(script)
        setApproval(null)
        setEditing(false)
        await production.refresh()
      }
    }
    window.addEventListener('industrial-video-submit-revision', submit)
    return () => window.removeEventListener('industrial-video-submit-revision', submit)
  }, [sessionId, executionBlocked, paths, snapshot, file, production])

  const progress = production.job?.progress as Record<string, unknown> | undefined
  const final = typeof progress?.final === 'string' ? progress.final : ''
  const done = production.job?.status === 'done'
  const onlineReady =
    done &&
    Boolean(final && run) &&
    progress?.final_stale !== true &&
    (!production.job?.run || production.job.run === run)
  const shownFinal = useRef('')
  useEffect(() => {
    const identity = `${production.record?.jobId}:${final}`
    if (onlineReady && shownFinal.current !== identity) {
      shownFinal.current = identity
      setPreviewVideo(true)
      setEditing(false)
    }
  }, [onlineReady, final, production.record?.jobId])
  /* 停用成片自动下载，预览改为签名网页。
  useEffect(() => {
    if (!done || !final || !run || progress?.final_stale === true || downloaded.current === final) return
    downloaded.current = final
    void ipcApi
      .request('industrial_video.download_artifact', { sessionId, run, path: final })
      .then((result) => {
        const local = normalizeFilePreviewPath(result.filePath)
        if (!local) throw new Error('成片路径无效。')
        if (alive.current && downloaded.current === final) {
          setVideo(local)
          setEditing(false)
        }
      })
      .catch(() => {
        if (alive.current && downloaded.current === final) setError('成片下载失败，请点击重试下载。')
      })
  }, [done, final, run, sessionId, progress?.final_stale])
  */

  const cards = (
    <section aria-label="审核与费用" className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      {snapshot ? (
        <>
          <p>请审阅脚本与分镜，确认后仅预估费用，不会自动开始付费生成。</p>
          <Button
            variant="outline"
            disabled={busy || !paths}
            onClick={() =>
              void execute(async () => {
                await file.flush()
                setSelected('script')
                setEditing(true)
                setPreviewVideo(false)
                setApproval(null)
              })
            }>
            我要修改脚本或分镜
          </Button>
          {editing && <p>待修改，尚未确认；退出编辑会保留本地草稿。</p>}
          <div className="flex flex-wrap gap-2">
            {(['script', 'storyboard'] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await file.flush()
                    setSelected(kind)
                    setEditing(false)
                    setPreviewVideo(false)
                  })
                }>
                {kind === 'script' ? '脚本.md' : '分镜脚本.md'}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">脚本编辑仅保存为本地草稿；修改后需重新编排，不能批准旧版脚本。</p>
          {scriptChanged && (
            <>
              <p role="status">脚本已修改为本地草稿，请重新编排后重新审核。</p>
              <Button
                disabled={executionBlocked || busy || file.conflict}
                onClick={() =>
                  void execute(async () => {
                    await file.flush()
                    const script = await window.api.fs.readText(paths!.script)
                    if (!script.trim()) throw new Error('本地脚本不能为空。')
                    const board = await window.api.fs.readText(paths!.storyboard)
                    const revision = appendIndustrialVideoRevision(
                      sessionId,
                      `请按本地脚本重新编排分镜，完成后等待重新审核。保留未要求修改的分镜字段：\n${board}`,
                      script
                    )
                    if (!revision) throw new Error('无法提交重新编排，请确认当前为专用制作会话。')
                    setSubmittedScript(script)
                    setApproval(null)
                    await production.refresh()
                  })
                }>
                按本地脚本重新编排
              </Button>
              <p>重新编排不会自动批准或开始付费视频生成；模型编排可能消耗模型额度。</p>
            </>
          )}
          {boardChanged && (
            <Button
              disabled={executionBlocked || busy || scriptChanged}
              onClick={() =>
                void execute(async () => {
                  setApproval(null)
                  await file.flush()
                  const text = await window.api.fs.readText(paths!.storyboard)
                  const storyboard = applyStoryboardDocument(text)
                  const context = await ipcApi.request('industrial_video.planning_context_get', {
                    sessionId,
                    run: run!
                  })
                  if (
                    context.sources_ready === false ||
                    typeof context.input_fingerprint !== 'string' ||
                    !context.input_fingerprint ||
                    typeof context.expected_storyboard_sha256 !== 'string'
                  )
                    throw new Error('规划上下文缺少有效指纹，请重新编排。')
                  const result = await ipcApi.request('industrial_video.storyboard_submit', {
                    sessionId,
                    run: run!,
                    storyboard,
                    expectedInputFingerprint: context.input_fingerprint,
                    expectedStoryboardSha256: context.expected_storyboard_sha256
                  })
                  if (!result.submitted) throw new Error('分镜提交未成功，请重试。')
                  await readSnapshot(true)
                })
              }>
              提交分镜修改
            </Button>
          )}
          <Button
            disabled={blocked}
            onClick={() =>
              void execute(async () => {
                setApproval(null)
                await file.flush()
                const script = await window.api.fs.readText(paths!.script)
                const board = await window.api.fs.readText(paths!.storyboard)
                if (script !== snapshot.script) {
                  setScriptChanged(true)
                  throw new Error('本地脚本已修改，请重新编排后再审核。')
                }
                if (board !== storyboardDocument(snapshot.storyboard).text) {
                  setSelected('storyboard')
                  setBoardChanged(true)
                  throw new Error('请先提交分镜修改，再重新审核。')
                }
                const receipt = await ipcApi.request('industrial_video.review_confirm', {
                  sessionId,
                  run: run!,
                  reviewType: 'script_and_storyboard',
                  expectedReviewVersion: snapshot.review_version
                })
                if (!receipt.generation_allowed || receipt.remaining_blockers.length)
                  throw new Error('审核尚有待处理事项，请重新编排后审核。')
                // 不再请求费用预估；只读取设置版本以保留并发变更保护。
                // const result = await ipcApi.request('industrial_video.estimate', { sessionId, run: run! })
                const context = await ipcApi.request('industrial_video.planning_context_get', { sessionId, run: run! })
                const effective = context.effective_settings as Record<string, unknown> | undefined
                const settingsVersion = context.settings_version ?? effective?.settings_version
                if (typeof settingsVersion !== 'number') throw new Error('无法获取设置版本，请刷新后重新审核。')
                if (alive.current)
                  setApproval({
                    // value: result.estimate,
                    // settingsVersion: result.settingsVersion ?? undefined,
                    settingsVersion,
                    reviewVersion: receipt.review_version
                  })
              })
            }>
            {/* 确认脚本与分镜并预估费用 */}
            确认脚本与分镜
          </Button>
        </>
      ) : (
        <p>正在准备可审核的脚本与分镜。</p>
      )}
      {approval && (
        <div className="space-y-2">
          {/* <p>费用预估</p>
          <dl>
            {Object.entries(estimateFields).map(([key, label]) => {
              const value = estimate.value[key]
              if (
                (typeof value !== 'number' || !Number.isFinite(value)) &&
                (typeof value !== 'string' || !value.trim())
              )
                return null
              return (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{String(value)}</dd>
                </div>
              )
            })}
          </dl>
          {!['total_cost', 'estimated_cost', 'total', 'cost'].some(
            (key) => typeof estimate.value[key] === 'number' && Number.isFinite(estimate.value[key])
          ) && <p>费用未知：服务端未提供明确金额，不推测价格，开始生成仍可能计费。</p>} */}
          <p>脚本与分镜已确认。本次生成可能产生费用，请确认后开始生成。</p>
          <Button
            disabled={blocked}
            onClick={() =>
              void execute(async () => {
                const approved = approval
                setApproval(null)
                await file.flush()
                if (
                  (await window.api.fs.readText(paths!.script)) !== snapshot!.script ||
                  (await window.api.fs.readText(paths!.storyboard)) !== storyboardDocument(snapshot!.storyboard).text
                )
                  throw new Error('本地文档已变更，请重新审核。')
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
                  throw new Error('审核内容已变更，请重新读取并审核。')
                await ipcApi.request('industrial_video.video_start', {
                  sessionId,
                  run: run!,
                  ...(approved.settingsVersion === undefined
                    ? {}
                    : { expectedSettingsVersion: approved.settingsVersion })
                })
                await production.refresh()
              })
            }>
            {t('industrial_video.task.confirm_cost')}
          </Button>
        </div>
      )}
      {video && (
        <div className="space-y-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditing(false)
              setPreviewVideo(true)
            }}>
            成片.mp4
          </Button>
          <details>
            <summary>技术详情</summary>
            <pre className="whitespace-pre-wrap break-all">{video}</pre>
          </details>
          <Button
            variant="outline"
            onClick={() =>
              void execute(async () => {
                await ipcApi.request('file.show_in_folder', createFilePathHandle(video))
              })
            }>
            打开所在文件夹
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void execute(async () => {
                const result = await ipcApi.request('file.read', {
                  handle: createFilePathHandle(video),
                  options: { mode: 'full', encoding: 'binary' }
                })
                await window.api.file.save('成片.mp4', result.content)
              })
            }>
            另存为
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {production.error && <p role="alert">无法同步制作进度，请刷新重试。</p>}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          void execute(async () => {
            await file.flush()
            await readSnapshot()
            await production.refresh()
          })
        }>
        刷新审核
      </Button>
      {/* 下载统一由在线成片区域的显式按钮触发。
      {done && final && progress?.final_stale !== true && !video && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const result = await ipcApi.request('industrial_video.download_artifact', {
                sessionId,
                run: run!,
                path: final
              })
              const local = normalizeFilePreviewPath(result.filePath)
              if (!local) throw new Error('成片路径无效。')
              setVideo(local)
            })
          }>
          重试下载
        </Button>
      )} */}
    </section>
  )

  return (
    <aside aria-label="制作文件预览" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {host ? createPortal(cards, host) : cards}
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        {(['script', 'storyboard'] as const).map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant={selected === kind && !previewVideo ? 'secondary' : 'ghost'}
            disabled={busy || !paths}
            onClick={() =>
              void execute(async () => {
                await file.flush()
                setSelected(kind)
                setEditing(false)
                setPreviewVideo(false)
              })
            }>
            {kind === 'script' ? '脚本' : '分镜'}
          </Button>
        ))}
        <Button
          size="sm"
          variant={onlineReady && previewVideo ? 'secondary' : 'ghost'}
          disabled={!onlineReady || busy}
          onClick={() =>
            void execute(async () => {
              await file.flush()
              setEditing(false)
              setPreviewVideo(true)
            })
          }>
          成片
        </Button>
        <span className="flex-1 text-xs text-muted-foreground">
          {onlineReady && previewVideo ? '成片在线预览' : selected === 'script' ? '脚本.md' : '分镜脚本.md'}
        </span>
        {path && !(onlineReady && previewVideo) && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                await file.flush()
                setEditing(!editing)
                setPreviewKey((value) => value + 1)
              })
            }>
            {editing ? '预览文档' : '编辑文档'}
          </Button>
        )}
      </div>
      {file.conflict ? (
        <div role="alert">
          <p>文件已被外部修改。重新加载会放弃当前本地编辑；保留草稿会覆盖磁盘内容。</p>
          <Button
            disabled={busy || file.isSaving}
            onClick={() =>
              void execute(async () => {
                setApproval(null)
                await file.reload()
                setPreviewKey((value) => value + 1)
              })
            }>
            重新加载磁盘文件（放弃本地编辑）
          </Button>
          <Button
            disabled={busy || file.isSaving}
            onClick={() =>
              void execute(async () => {
                setApproval(null)
                await file.keepDraft()
              })
            }>
            保留草稿并覆盖
          </Button>
        </div>
      ) : (
        (file.error || file.saveError) && (
          <div role="alert">
            <p>文件读取或保存失败，本地草稿已保留。</p>
            <Button
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  if (file.saveError) await file.flush()
                  else await file.reload()
                })
              }>
              重试文件操作
            </Button>
          </div>
        )
      )}
      <div className="min-h-0 flex-1">
        {/* <FilePreview filePath={video} /> */}
        {onlineReady && (
          <div className={previewVideo ? 'h-full' : 'hidden'}>
            <IndustrialVideoOnlinePreview
              key={`${sessionId}:${run}:${production.record?.jobId}:${final}`}
              sessionId={sessionId}
              run={run!}
              finalPath={final}
              previewUrl={progress?.preview_url}
              onDownloaded={(saved) => setVideo(normalizeFilePreviewPath(saved))}
            />
          </div>
        )}
        {!(onlineReady && previewVideo) &&
          path &&
          (editing ? (
            file.status === 'ready' && (
              <CodeEditor
                value={file.draft}
                language="markdown"
                height="100%"
                wrapped
                onChange={(value) => {
                  file.setDraft(value)
                  setApproval(null)
                  if (selected === 'script') {
                    localStorage.setItem(draftKey, value)
                    setSubmittedScript(null)
                    setScriptChanged(true)
                  } else {
                    localStorage.setItem(boardDraftKey, value)
                    setSubmittedScript(null)
                    setBoardChanged(true)
                  }
                }}
              />
            )
          ) : (
            <FilePreview filePath={path} refreshKey={previewKey} />
          ))}
      </div>
    </aside>
  )
}
