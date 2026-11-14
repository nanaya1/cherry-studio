import { use, useEffect, useMemo, useState, type ReactNode } from 'react'

import { Button } from '@cherrystudio/ui'
import { useOptionalMessageListActions } from '@renderer/components/chat/messages/MessageListProvider'
import { ToolResultAttachmentsContext } from '@renderer/components/chat/messages/tools/shared/ToolDisplayNames'
// eslint-disable-next-line import-x/no-restricted-paths
import { useAgentRightPaneActions } from '@renderer/pages/agents/components/AgentRightPane'
import { normalizeFilePreviewPath } from '@renderer/utils/filePreview'
import { joinPath } from '@renderer/utils/path'
import { normalizeMeacoworkToolRuntimeName, toMeacoworkToolRuntimeName } from '@shared/ai/meacoworkTools'

import { openIndustrialVideoReviewDocument } from './industrialVideoProgressStore'

function readSnapshot(output: unknown) {
  try {
    const content = (output as { content?: { type: string; text?: string }[] })?.content
    const text = content?.find((part) => part.type === 'text')?.text
    const value = text ? JSON.parse(text) : output
    if (
      !value ||
      value.ok === false ||
      typeof value.review_version !== 'string' ||
      !value.review_version ||
      typeof value.script !== 'string' ||
      !value.script.trim() ||
      !Array.isArray(value.storyboard?.scenes)
    )
      return null
    return value as {
      review_version: string
      script: string
      storyboard: { video_title?: string; scenes: Record<string, unknown>[] }
    }
  } catch {
    return null
  }
}

export function IndustrialVideoReviewFilesProvider({
  workspace,
  children
}: {
  workspace?: string
  children: ReactNode
}) {
  const parentAttachments = use(ToolResultAttachmentsContext)
  const render = useMemo(
    () => (toolName: string, output: unknown) =>
      normalizeMeacoworkToolRuntimeName(toolName) === toMeacoworkToolRuntimeName('ivideo_review_snapshot_get') &&
      readSnapshot(output) ? (
        <IndustrialVideoReviewFiles output={output} workspace={workspace} />
      ) : (
        parentAttachments?.(toolName, output)
      ),
    [workspace, parentAttachments]
  )
  return <ToolResultAttachmentsContext value={render}>{children}</ToolResultAttachmentsContext>
}

export default function IndustrialVideoReviewFiles({
  output,
  workspace,
  sessionId,
  run
}: {
  output: unknown
  workspace?: string
  sessionId?: string
  run?: string
}) {
  const snapshot = useMemo(() => readSnapshot(output), [output])
  const actions = useOptionalMessageListActions()
  const pane = useAgentRightPaneActions()
  const openFile = actions?.openArtifactFile ?? pane.openArtifactFile
  // const [saved, setSaved] = useState<{ source: unknown; files: { path: string; name: string }[] } | null>(null)
  const [saved, setSaved] = useState<{
    source: unknown
    files: { path: string; name: string; content: string }[]
  } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSaved(null)
    setError('')
    if (!snapshot) return
    const save = async () => {
      // 每次快照使用独立文件，避免覆盖历史审核副本或用户草稿。
      const stem = `审核-${crypto.randomUUID()}-`
      const title = String(snapshot.storyboard.video_title ?? '视频制作')
      // 无用户工作区时使用现有临时文件接口，不要求额外选择目录。
      const files = await Promise.all(
        ['全文脚本', '动作分镜'].map(async (kind) => ({
          path: normalizeFilePreviewPath(
            workspace
              ? joinPath(workspace, `${stem}${kind}.md`)
              : await window.api.file.createTempFile(`${stem}${kind}.md`)
          ),
          name: `${title}·${kind}.md`
        }))
      )
      if (files.some((file) => !file.path)) throw new Error('工作区路径无效，无法保存审核文件。')
      const board =
        `# ${title}\n\n审核版本：${snapshot.review_version}\n\n` +
        snapshot.storyboard.scenes
          .map(
            (scene, index) =>
              `## ${index + 1}. ${String(scene.title ?? '镜头')} · ${String(scene.duration ?? '')} 秒\n\n` +
              `### 画面\n\n${String(scene.prompt ?? '')}\n\n` +
              `### 旁白\n\n${Array.isArray(scene.narration) ? scene.narration.map((item) => String(item.text ?? '')).join('\n\n') : ''}\n\n` +
              `### 动作与核验\n\n${
                scene.state_transition && typeof scene.state_transition === 'object'
                  ? Object.entries(scene.state_transition)
                      .filter(([key]) => ['action_en', 'contact_en', 'verification_en'].includes(key))
                      .map(
                        ([key, value]) =>
                          `- ${{ action_en: '动作', contact_en: '接触方式', verification_en: '核验' }[key]}：${String(value)}`
                      )
                      .join('\n')
                  : ''
              }`
          )
          .join('\n\n')
      await window.api.file.write(files[0].path, snapshot.script)
      await window.api.file.write(files[1].path, board)
      // if (active) setSaved({ source: output, files })
      if (active)
        setSaved({
          source: output,
          files: files.map((file, index) => ({ ...file, content: index === 0 ? snapshot.script : board }))
        })
    }
    void save().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      active = false
    }
  }, [snapshot, workspace, output])
  if (!snapshot) return null
  // 缺少工作区时由临时文件承载预览。
  if (error)
    return (
      <p role="alert" className="text-error">
        审核文件保存失败：{error}
      </p>
    )
  if (!saved || saved.source !== output) return <p role="status">正在准备脚本与分镜预览文件…</p>
  return (
    <div className="my-2 space-y-2">
      <p className="text-sm text-muted-foreground">点击文件在右侧查看完整内容。</p>
      {saved.files.map((file) => (
        <Button
          key={file.path}
          variant="outline"
          className="h-auto w-full justify-start whitespace-normal py-3 text-left"
          disabled={!openFile}
          onClick={() => {
            void Promise.resolve()
              // .then(() => openFile?.(file.path))
              .then(() => {
                if (sessionId && run) openIndustrialVideoReviewDocument(sessionId, run, file)
                else openFile?.(file.path)
              })
              .catch((cause) => setError(String(cause)))
          }}>
          {file.name}
        </Button>
      ))}
    </div>
  )
}
