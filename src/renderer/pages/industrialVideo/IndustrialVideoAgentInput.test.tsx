import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import type { ComposerSurfaceProps } from '@renderer/components/composer/ComposerSurface'

import IndustrialVideoAgentInput from './IndustrialVideoAgentInput'

const mocks = vi.hoisted(() => ({ state: 'storyboard_submitted', error: '', send: vi.fn(), job: { status: 'done' } }))
vi.mock('./useIndustrialVideoProduction', () => ({
  useIndustrialVideoProduction: () => ({
    record: { state: mocks.state, unknownSubmissions: [] },
    error: mocks.error,
    job: mocks.job,
    refresh: vi.fn(async () => {})
  })
}))
vi.mock('@renderer/components/composer/ComposerSurface', async () => {
  const { useComposerToolProviderState } = await import('@renderer/components/composer/tools/ComposerToolProvider')
  return {
    default: function ComposerSurfaceStub(props: ComposerSurfaceProps) {
      useComposerToolProviderState()
      return (
        <div>
          <textarea
            aria-label={props.placeholder}
            value={props.text}
            onChange={(e) => props.onTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void props.onSendDraft({ text: props.text, tokens: [] })
            }}
          />
          {props.renderLeftControls?.()}
          {props.topContent}
        </div>
      )
    }
  }
})
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.send.mockResolvedValue(true)
  mocks.state = 'storyboard_submitted'
})

it('保留原审核确认覆盖层，不能因替换输入而丢失待确认卡', () => {
  render(
    <IndustrialVideoAgentInput
      sessionId="s"
      enabled
      blocked={false}
      sendMessage={mocks.send}
      composerContext={{ overrides: [{ id: 'approval', priority: 10, render: () => <div>脚本与分镜待确认</div> }] }}>
      {null}
    </IndustrialVideoAgentInput>
  )
  expect(screen.getByText('脚本与分镜待确认')).toBeVisible()
})

it('普通任务原样放行，不创建工业输入或发送通道', () => {
  render(
    <IndustrialVideoAgentInput sessionId="s" enabled={false} blocked={false} sendMessage={mocks.send}>
      <div>普通输入</div>
    </IndustrialVideoAgentInput>
  )
  expect(screen.getByText('普通输入')).toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(mocks.send).not.toHaveBeenCalled()
})
it('工业任务替换普通输入，通过原Agent回调显式提交，不自动批准', async () => {
  render(
    <IndustrialVideoAgentInput sessionId="s" enabled blocked={false} sendMessage={mocks.send}>
      <div>普通输入</div>
    </IndustrialVideoAgentInput>
  )
  expect(screen.queryByText('普通输入')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '缩短片头' } })
  fireEvent.click(screen.getByRole('button', { name: '提交修改' }))
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith({ text: expect.stringContaining('缩短片头') }))
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
})
it('执行中允许写草稿，按钮和回车禁止发送，重新挂载草稿仍在', async () => {
  mocks.state = 'generating'
  const ui = (
    <IndustrialVideoAgentInput sessionId="s" enabled blocked={false} sendMessage={mocks.send}>
      <div>普通输入</div>
    </IndustrialVideoAgentInput>
  )
  const view = render(ui)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '稍后修改' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(screen.getByRole('button', { name: '提交修改' })).toBeDisabled()
  expect(mocks.send).not.toHaveBeenCalled()
  view.unmount()
  render(ui)
  expect(screen.getByRole('textbox')).toHaveValue('稍后修改')
})
it('切换会话不串草稿，返回原会话可恢复', () => {
  const view = render(
    <IndustrialVideoAgentInput sessionId="a" enabled blocked={false} sendMessage={mocks.send}>
      {null}
    </IndustrialVideoAgentInput>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A的修改' } })
  view.rerender(
    <IndustrialVideoAgentInput sessionId="b" enabled blocked={false} sendMessage={mocks.send}>
      {null}
    </IndustrialVideoAgentInput>
  )
  expect(screen.getByRole('textbox')).toHaveValue('')
  view.rerender(
    <IndustrialVideoAgentInput sessionId="a" enabled blocked={false} sendMessage={mocks.send}>
      {null}
    </IndustrialVideoAgentInput>
  )
  expect(screen.getByRole('textbox')).toHaveValue('A的修改')
})

it('Agent仍执行时不发送也不排队', () => {
  render(
    <IndustrialVideoAgentInput sessionId="s" enabled blocked sendMessage={mocks.send}>
      {null}
    </IndustrialVideoAgentInput>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '等待' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(screen.getByRole('button', { name: '提交修改' })).toBeDisabled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('发送失败保留草稿，不进入自动重试或队列', async () => {
  mocks.send.mockResolvedValue(false)
  render(
    <IndustrialVideoAgentInput sessionId="s" enabled blocked={false} sendMessage={mocks.send}>
      {null}
    </IndustrialVideoAgentInput>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留修改' } })
  fireEvent.click(screen.getByRole('button', { name: '提交修改' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('textbox')).toHaveValue('保留修改')
  expect(mocks.send).toHaveBeenCalledTimes(1)
})
