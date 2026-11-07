import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import {
  useComposerToolProviderDispatch,
  useComposerToolProviderLaunchers
} from '@renderer/components/composer/tools/ComposerToolProvider'

import IndustrialVideoComposer from './IndustrialVideoComposer'

vi.mock('@renderer/components/composer/ComposerSurface', () => ({
  default: function MockComposerSurface({ text }: { text: string }) {
    useComposerToolProviderLaunchers()
    const { onTextChange } = useComposerToolProviderDispatch()
    return <textarea aria-label="视频需求" value={text} onChange={(event) => onTextChange(event.target.value)} />
  }
}))
vi.mock('@renderer/components/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('@renderer/components/resourceCatalog/dialogs/components/PromptPolishActions', () => ({
  PromptPolishActions: () => null
}))
vi.mock('@renderer/utils/model', () => ({ readDefaultModel: async () => undefined }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
})
afterEach(cleanup)

it('宿主提供真实工具 context，工具文本更新写回会话草稿', async () => {
  const user = userEvent.setup()
  render(<IndustrialVideoComposer sessionId="tool-context" />)

  await user.type(screen.getByRole('textbox', { name: '视频需求' }), '工具更新的需求')

  await waitFor(() =>
    expect(cacheService.getPersist('industrial_video.session_draft.tool-context')?.requirement).toBe('工具更新的需求')
  )
})
