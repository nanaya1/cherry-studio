import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import IndustrialVideoGenerationLoading, { readGenerationProgress } from './IndustrialVideoGenerationLoading'
import { publishIndustrialVideoStop } from './industrialVideoProgressStore'

it('停止制作在进度区域显示边框按钮，禁用等待且会话隔离', () => {
  const onStop = vi.fn()
  publishIndustrialVideoStop('stop-test', { stop: onStop, stopping: false })
  const progress = readGenerationProgress({}, 'generating', null)
  const { rerender } = render(<IndustrialVideoGenerationLoading progress={progress} sessionId="stop-test" />)
  const button = screen.getByRole('button', { name: '停止制作' })
  expect(button).toHaveClass('border', 'border-border', 'bg-background')
  expect(screen.getByRole('region', { name: '视频制作实时进度' })).toContainElement(button)
  fireEvent.click(button)
  expect(onStop).toHaveBeenCalledTimes(1)
  publishIndustrialVideoStop('stop-test', { stop: onStop, stopping: true })
  rerender(<IndustrialVideoGenerationLoading progress={progress} sessionId="stop-test" />)
  expect(screen.getByRole('button', { name: '正在停止制作' })).toBeDisabled()
  rerender(<IndustrialVideoGenerationLoading progress={progress} sessionId="other-session" />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  publishIndustrialVideoStop('stop-test', null)
})

// 防止服务端标准字段被遗漏，或把全部镜头完成误报为成片完成。
it('uses server scene counts and stage without inventing the next scene', () => {
  const progress = readGenerationProgress(
    { scenes_done: 3, scenes_total: 5, stage_current: 'video' },
    'generating',
    null
  )
  render(<IndustrialVideoGenerationLoading progress={progress} />)
  expect(screen.getByText('已完成 3/5 个分镜')).toBeInTheDocument()
  expect(screen.queryByText(/第 4/)).toBeNull()
  expect(
    readGenerationProgress({ scenes_done: 5, scenes_total: 5, stage_current: 'assemble' }, 'generating', null).label
  ).toBe('正在合成成片')
})
it('does not fabricate zero or accept invalid counts', () => {
  expect(readGenerationProgress({}, 'generating', null).done).toBeNull()
  expect(readGenerationProgress({ scenes_done: 7, scenes_total: 5 }, 'generating', 3).done).toBeNull()
  render(<IndustrialVideoGenerationLoading progress={readGenerationProgress({}, 'generating', null)} />)
  expect(screen.getByText('等待服务端返回分镜进度')).toBeInTheDocument()
})
it('stops animation and exposes interruptions rather than pretending to advance', () => {
  const { container } = render(
    <IndustrialVideoGenerationLoading
      progress={readGenerationProgress({ scenes_done: 2, scenes_total: 5 }, 'generating', null)}
      stopped="生成失败"
      error="服务端任务失败"
    />
  )
  expect(container.querySelector('[data-animating="false"]')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('服务端任务失败')
  expect(screen.getByRole('heading', { name: '生成失败' })).toBeInTheDocument()
})
