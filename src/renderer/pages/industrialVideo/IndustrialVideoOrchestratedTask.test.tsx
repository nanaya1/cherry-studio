import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { render, screen, cleanup, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'

import { IndustrialVideoTaskComposer, IndustrialVideoTaskSurface } from './IndustrialVideoOrchestratedTask'
import { createIndustrialVideoSettings } from './industrialVideoSettings'
vi.mock('@renderer/data/hooks/useCache', async (original) => await original())
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn(async () => null) } }))
vi.mock('./IndustrialVideoTaskPanel', () => ({ default: () => <div>Review controls</div> }))
beforeEach(() => MockCacheUtils.resetMocks())
afterEach(cleanup)
const host = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-ui="${name}"]`) as HTMLElement | null

it.each(['analyzing', 'parsing', 'planning', 'failed'] as const)(
  'reflects %s preparation without a false running state',
  (stage) => {
    const draft = {
      orchestration: 'dedicated' as const,
      requirement: 'Loading regression',
      modelId: 'test::model' as const,
      settings: createIndustrialVideoSettings('marketing')
    }
    cacheService.setPersist('industrial_video.session_draft.s1', draft)
    cacheService.setPersist('industrial_video.preparation.s1', {
      input: draft,
      stage,
      result: '',
      error: stage === 'failed' ? 'Rejected parse' : '',
      startedAt: 1,
      updatedAt: 1
    })
    const { container } = render(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    expect(host(container, 'industrial-video.review-message')).toBeInTheDocument()
    expect(host(container, 'industrial-video.review-preview')).toBeInTheDocument()
    if (stage === 'failed') {
      expect(screen.getByRole('alert')).toHaveTextContent('Rejected parse')
    }
  }
)
it('keeps legacy chat and composer when a task has no dedicated enrollment', () => {
  render(
    <>
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
      <IndustrialVideoTaskComposer sessionId="s1">
        <button type="button">Send message</button>
      </IndustrialVideoTaskComposer>
    </>
  )
  expect(screen.getByText('Original messages')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
})
it('renders dedicated workbench and prevents agent submission for dedicated tasks', () => {
  cacheService.setPersist('industrial_video.session_draft.s1', {
    orchestration: 'dedicated',
    requirement: 'BT-800 设备视频',
    modelId: 'test::model' as const,
    settings: createIndustrialVideoSettings('marketing')
  })
  const { container } = render(
    <>
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
      <IndustrialVideoTaskComposer sessionId="s1">
        <button type="button">Send message</button>
      </IndustrialVideoTaskComposer>
    </>
  )
  expect(host(container, 'industrial-video.review-message')).toBeInTheDocument()
  expect(host(container, 'industrial-video.review-preview')).toBeInTheDocument()
  expect(screen.getByRole('textbox')).toBeInTheDocument()
  // 普通 Agent 发送入口被专用输入替换
  expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
  expect(within(host(container, 'industrial-video.review-preview')!).getByText('Review controls')).toBeInTheDocument()
})
