import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import IndustrialVideoReviewFiles from './IndustrialVideoReviewFiles'

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
  Object.assign(window, { api: { file: { write } } })
})
it('saves the real snapshot as two files and opens the selected file only on click', async () => {
  render(<IndustrialVideoReviewFiles output={output} workspace="/workspace" />)
  const script = await screen.findByRole('button', { name: '网络重置·脚本.md' })
  expect(write).toHaveBeenCalledTimes(2)
  expect(write.mock.calls[0]).toContain('# 真实脚本')
  expect(openArtifactFile).not.toHaveBeenCalled()
  fireEvent.click(script)
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledWith(expect.stringMatching(/脚本\.md$/)))
  expect(screen.queryByText('确认')).toBeNull()
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
