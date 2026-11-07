import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'
import type { Model } from '@shared/data/types/model'

const mocks = vi.hoisted(() => ({ fetchGenerate: vi.fn() }))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('@renderer/utils/aiGeneration', () => ({ fetchGenerate: mocks.fetchGenerate }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'library.config.prompt.polish') return '润色提示词'
      if (key === 'library.config.prompt.generate') return '生成提示词'
      return key
    }
  })
}))

import { PromptPolishActions } from '../PromptPolishActions'

const selectedModel: Model = {
  id: 'test-provider::polish-model',
  providerId: 'test-provider',
  name: '提示词模型',
  capabilities: [],
  supportsStreaming: false,
  isEnabled: true,
  isHidden: false
}

beforeEach(() => {
  mocks.fetchGenerate.mockReset().mockResolvedValue('生成后的提示词')
})

describe('PromptPolishActions 模型选择', () => {
  it.each([
    { value: '原始提示词', fallbackSource: undefined, action: '润色提示词', prompt: '润色策略', content: '原始提示词' },
    { value: '', fallbackSource: '视频标题', action: '生成提示词', prompt: '生成策略', content: '视频标题' }
  ])('$action 使用指定模型', async ({ value, fallbackSource, action, prompt, content }) => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <PromptPolishActions
        value={value}
        fallbackSource={fallbackSource}
        model={selectedModel}
        emptyValueSystemPrompt="生成策略"
        existingValueSystemPrompt="润色策略"
        onChange={onChange}
      />
    )

    await user.click(screen.getByRole('button', { name: action }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('生成后的提示词'))
    expect(mocks.fetchGenerate).toHaveBeenCalledWith({
      prompt,
      content,
      model: selectedModel,
      throwOnError: true,
      signal: expect.any(AbortSignal)
    })
  })

  it('未指定模型时保持默认模型调用且不增加 model 字段', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <PromptPolishActions
        value="原始提示词"
        emptyValueSystemPrompt="生成策略"
        existingValueSystemPrompt="润色策略"
        onChange={onChange}
      />
    )

    await user.click(screen.getByRole('button', { name: '润色提示词' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('生成后的提示词'))
    expect(mocks.fetchGenerate).toHaveBeenCalledWith({
      prompt: '润色策略',
      content: '原始提示词',
      throwOnError: true,
      signal: expect.any(AbortSignal)
    })
    expect(mocks.fetchGenerate.mock.calls[0][0]).not.toHaveProperty('model')
  })
})
