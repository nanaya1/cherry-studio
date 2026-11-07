import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import IndustrialVideoGenerationLoading, { readGenerationProgress } from './IndustrialVideoGenerationLoading'

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
