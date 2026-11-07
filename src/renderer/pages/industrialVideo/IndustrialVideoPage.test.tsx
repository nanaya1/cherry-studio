import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { resolveAgentEntrySessionId } from '@renderer/utils/conversationEntry'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

vi.unmock('@renderer/data/hooks/useCache')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (key === 'industrial_video.analyzing' ? '正在分析资料' : key) })
}))
vi.mock('./IndustrialVideoComposer', () => ({ default: () => null }))
vi.mock('./IndustrialVideoSettingsForm', () => ({ default: () => null }))

import IndustrialVideoPage from './IndustrialVideoPage'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
})

it('使用统一工具页骨架并让新建与已有会话共享同一内容宽度', () => {
  const session = { id: 'video-layout', name: '视频任务' } as AgentSessionEntity
  const { rerender } = render(<IndustrialVideoPage />)
  const newPage = screen.getByRole('main')
  // 原工具页骨架已由创建页替代，保留当前滚动区和输入框宽度契约。
  // expect(newPage).toHaveAttribute('data-ui', 'industrial-video.view')
  // expect(newPage).toHaveClass('relative', 'flex', 'h-full', 'flex-col', 'overflow-hidden', 'bg-background')
  // expect(newPage.querySelector('[data-ui~="industrial-video.content"]')).toHaveClass('max-w-4xl')
  expect(newPage).toHaveAttribute('data-ui', 'industrial-video.workspace')
  expect(newPage.querySelector('[data-composer-dock-layer]')).toHaveClass('max-w-2xl')

  rerender(<IndustrialVideoPage session={session} />)
  // expect(screen.getByRole('banner')).toHaveClass('h-12', 'border-border-subtle', 'px-4')
  // expect(screen.getByRole('main').querySelector('[data-ui~="industrial-video.content"]')).toHaveClass('max-w-4xl')
  expect(screen.getByRole('main').querySelector('[data-composer-dock-layer]')).toHaveClass('max-w-2xl')
})

it('解析中重开详情展示已提交内容和真实阶段，失败仍保留输入', () => {
  const input = {
    requirement: '设备宣传需求',
    modelId: null,
    settings: createIndustrialVideoSettings('marketing'),
    attachments: [{ fileTokenSourceId: 'manual', name: 'manual', origin_name: 'manual.pdf', ext: '.pdf', size: 20 }]
  }
  cacheService.setPersist('industrial_video.preparation.detail-test', {
    input,
    stage: 'analyzing',
    result: '',
    error: '',
    startedAt: Date.now(),
    updatedAt: Date.now()
  })
  const view = render(<IndustrialVideoPage session={{ id: 'detail-test' } as AgentSessionEntity} />)
  expect(screen.getByText('设备宣传需求')).toBeVisible()
  expect(screen.getByText('manual.pdf')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('正在分析资料')
  view.unmount()
  cacheService.setPersist('industrial_video.preparation.detail-test', {
    input,
    stage: 'failed',
    result: '实际模型分析',
    error: '服务暂不可用',
    startedAt: Date.now(),
    updatedAt: Date.now()
  })
  render(<IndustrialVideoPage session={{ id: 'detail-test' } as AgentSessionEntity} />)
  expect(screen.getByText('设备宣传需求')).toBeVisible()
  expect(screen.getByText('实际模型分析')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('服务暂不可用')
})

it('普通会话 → 视频 → 裸普通入口仍恢复普通会话', async () => {
  cacheService.setPersist('ui.agent.last_used_session_id', 'general-last')
  vi.mocked(dataApiService.get).mockImplementation(
    async (path) =>
      ({
        id: path.slice('/agent-sessions/'.length),
        featureKind: path.endsWith('video-last') ? 'industrial-video' : 'general'
      }) as never
  )
  const { container } = render(
    <IndustrialVideoPage session={{ id: 'video-last', name: '视频' } as AgentSessionEntity} />
  )
  expect(container.querySelector('[data-composer-dock-layer]')).toHaveClass('max-w-2xl')
  expect(container.querySelector('[data-ui="industrial-video.workspace"]')).toHaveClass(
    'items-center',
    'justify-center'
  )
  await expect(resolveAgentEntrySessionId()).resolves.toBe('general-last')
  expect(cacheService.getPersist('ui.agent.last_used_session_id')).toBe('general-last')
})
