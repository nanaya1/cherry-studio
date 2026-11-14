import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { useIndustrialVideoWorkbench } from './industrialVideoProgressStore'
import IndustrialVideoReviewFiles from './IndustrialVideoReviewFiles'

function PreviewProbe() {
  const preview = useIndustrialVideoWorkbench('review-session')
  return preview?.document ? <aside aria-label="审核文档预览">{preview.document.content}</aside> : null
}

vi.mock('@renderer/pages/agents/components/AgentRightPane', () => ({
  useAgentRightPaneActions: () => ({ openArtifactFile })
}))
const openArtifactFile = vi.fn()
const write = vi.fn<(path: string, content: string) => Promise<void>>(async () => undefined)
vi.mock('@renderer/components/chat/messages/MessageListProvider', () => ({
  useOptionalMessageListActions: () => ({ openArtifactFile })
}))
const output = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        ok: true,
        review_version: 'v7',
        script: '# 真实脚本',
        storyboard: {
          video_title: '网络重置',
          scenes: [{ title: '备份', narration: '保存参数', prompt_en: 'Private generation prompt' }]
        }
      })
    }
  ]
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { file: { write, createTempFile: vi.fn(async (name: string) => `/tmp/${name}`) } } })
})
it('saves the real snapshot as two files and opens the selected file only on click', async () => {
  render(<IndustrialVideoReviewFiles output={output} workspace="/workspace" />)
  const script = await screen.findByRole('button', { name: '网络重置·全文脚本.md' })
  expect(write).toHaveBeenCalledTimes(2)
  expect(write.mock.calls[0]).toContain('# 真实脚本')
  expect(openArtifactFile).not.toHaveBeenCalled()
  fireEvent.click(script)
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledWith(expect.stringMatching(/脚本\.md$/)))
  expect(screen.queryByText('确认')).toBeNull()
})
it('没有工作区也能预览可读分镜，不展示机器字段', async () => {
  render(
    <IndustrialVideoReviewFiles
      output={{
        review_version: 'v8',
        script: '全文',
        storyboard: {
          scenes: [{ title: '检查', duration: 5, prompt: '观察防护罩', narration: [{ text: '安全检查' }] }]
        }
      }}
    />
  )
  await screen.findByRole('button', { name: '视频制作·动作分镜.md' })
  expect(write.mock.calls[1][1]).toContain('### 画面\n\n观察防护罩')
  expect(write.mock.calls[1][1]).toContain('### 旁白\n\n安全检查')
  expect(write.mock.calls[1][1]).not.toContain('scene_uid')
})

it('无工作目录点击审核文件后在工业专属预览显示真实内容，不调用通用文件入口', async () => {
  render(
    <>
      <IndustrialVideoReviewFiles output={output} sessionId="review-session" run="original-run" />
      <PreviewProbe />
    </>
  )
  fireEvent.click(await screen.findByRole('button', { name: '网络重置·全文脚本.md' }))
  expect(await screen.findByRole('complementary', { name: '审核文档预览' })).toHaveTextContent('# 真实脚本')
  expect(openArtifactFile).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '网络重置·动作分镜.md' }))
  await waitFor(() => expect(screen.getByRole('complementary', { name: '审核文档预览' })).toHaveTextContent('备份'))
})

it('does not create files for failed or incomplete snapshots', () => {
  render(
    <IndustrialVideoReviewFiles output={{ content: [{ type: 'text', text: '{"ok":false}' }] }} workspace="/workspace" />
  )
  expect(write).not.toHaveBeenCalled()
  expect(screen.queryByRole('button')).toBeNull()
})
it('reports save failure without showing usable file cards', async () => {
  write.mockRejectedValueOnce(new Error('write failed'))
  render(<IndustrialVideoReviewFiles output={output} workspace="/workspace" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('write failed')
  expect(screen.queryByRole('button')).toBeNull()
})
