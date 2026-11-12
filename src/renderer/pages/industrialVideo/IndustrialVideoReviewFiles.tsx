import { use, useEffect, useMemo, useState, type ReactNode } from 'react'

import { Button } from '@cherrystudio/ui'
import { useOptionalMessageListActions } from '@renderer/components/chat/messages/MessageListProvider'
import { ToolResultAttachmentsContext } from '@renderer/components/chat/messages/tools/shared/ToolDisplayNames'
import { normalizeFilePreviewPath } from '@renderer/utils/filePreview'
import { joinPath } from '@renderer/utils/path'
import { normalizeMeacoworkToolRuntimeName, toMeacoworkToolRuntimeName } from '@shared/ai/meacoworkTools'

function readSnapshot(output: unknown) {
  try {
    const content = (output as { content?: { type: string; text?: string }[] })?.content
    const text = content?.find((part) => part.type === 'text')?.text
    if (!text) return null
    const value = JSON.parse(text)
    if (
      value.ok !== true ||
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

export default function IndustrialVideoReviewFiles({ output, workspace }: { output: unknown; workspace?: string }) {
  const snapshot = useMemo(() => readSnapshot(output), [output])
  const actions = useOptionalMessageListActions()
  const [saved, setSaved] = useState<{ source: unknown; files: { path: string; name: string }[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSaved(null)
    setError('')
    if (!snapshot || !workspace) return
    const save = async () => {
      // 每次快照使用独立文件，避免覆盖历史审核副本或用户草稿。
      const stem = `审核-${crypto.randomUUID()}-`
      const title = String(snapshot.storyboard.video_title ?? '视频制作')
      const files = ['脚本', '分镜脚本'].map((kind) => ({
        path: normalizeFilePreviewPath(joinPath(workspace, `${stem}${kind}.md`)),
        name: `${title}·${kind}.md`
      }))
      if (files.some((file) => !file.path)) throw new Error('工作区路径无效，无法保存审核文件。')
      const board =
        `# ${title}\n\n审核版本：${snapshot.review_version}\n\n` +
        snapshot.storyboard.scenes
          .map(
            (scene, index) =>
              `## 镜头 ${index + 1}\n\n` +
              Object.entries(scene)
                .map(([key, value]) => `- ${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`)
                .join('\n')
          )
          .join('\n\n')
      await window.api.file.write(files[0].path, snapshot.script)
      await window.api.file.write(files[1].path, board)
      if (active) setSaved({ source: output, files })
    }
    void save().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      active = false
    }
  }, [snapshot, workspace, output])
  if (!snapshot) return null
  if (!workspace) return <p role="alert">无法准备审核文件：当前会话缺少工作区。</p>
  if (error)
    return (
      <p role="alert" className="text-error">
        审核文件保存失败：{error}
      </p>
    )
  if (!saved || saved.source !== output) return <p role="status">正在准备脚本与分镜预览文件…</p>
  return (
    <div className="my-2 space-y-2">
      <p className="text-sm text-muted-foreground">
        脚本与分镜已生成，点击文件在右侧预览；请在现有审核选项中确认。版本：{snapshot.review_version}
      </p>
      {saved.files.map((file) => (
        <Button
          key={file.path}
          variant="outline"
          className="h-auto w-full justify-start whitespace-normal py-3 text-left"
          disabled={!actions?.openArtifactFile}
          onClick={() => {
            void Promise.resolve()
              .then(() => actions?.openArtifactFile?.(file.path))
              .catch((cause) => setError(String(cause)))
          }}>
          {file.name}
        </Button>
      ))}
    </div>
  )
}
