import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { MockUseDataApiUtils, mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { Route } from '@renderer/routes/app/industrial-video'

import IndustrialVideoComposer from './IndustrialVideoComposer'

vi.mock('@cherrystudio/ui', async (importOriginal) => await importOriginal())

const mocks = vi.hoisted(() => ({ reuseOrCreateSession: vi.fn() }))
vi.mock('@renderer/hooks/resourceViewSources', () => ({ useAgentSessionsSource: () => mocks }))

beforeEach(async () => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
  MockUseDataApiUtils.resetMocks()
  await i18next.changeLanguage('en-us')
  window.scrollTo = vi.fn()
  const defaultQuery = mockUseQuery.getMockImplementation()!
  mockUseQuery.mockImplementation((path, options) => {
    const result = defaultQuery(path, options)
    if (path === '/agents') {
      return {
        ...result,
        data: { items: [{ id: 'builtin', configuration: { builtin_role: 'assistant' } }] }
      }
    }
    if (path === '/providers' || path === '/models') return { ...result, data: [] }
    return result
  })
  mocks.reuseOrCreateSession.mockResolvedValue({
    session: { id: 'runtime-video', featureKind: 'industrial-video' },
    created: true
  })
  window.api.file.select = vi.fn().mockResolvedValue([])
})

afterEach(cleanup)

describe('工业视频真实 Composer 运行链', () => {
  it.each(['已有会话', 'New 入口'] as const)(
    '%s 聚焦并输入后仍可编辑、打开附件和模型选择，且不发送普通 Agent',
    async (entry) => {
      const user = userEvent.setup()
      if (entry === '已有会话') {
        render(
          <QuickPanelProvider>
            <IndustrialVideoComposer sessionId="runtime-video" />
          </QuickPanelProvider>
        )
      } else {
        const root = createRootRoute()
        const route = createRoute({
          getParentRoute: () => root,
          path: '/app/industrial-video',
          component: Route.options.component
        })
        const router = createRouter({
          routeTree: root.addChildren([route]),
          history: createMemoryHistory({ initialEntries: ['/app/industrial-video'] })
        })
        await router.load()
        await act(async () => {
          render(
            <StrictMode>
              <QuickPanelProvider>
                <RouterProvider router={router} />
              </QuickPanelProvider>
            </StrictMode>
          )
        })
      }

      // 聚焦空壳后等待真实 contenteditable，避免只验证懒加载前的 textarea。
      await user.click(await screen.findByRole('textbox'))
      await act(async () => {
        await import('@renderer/components/composer/ComposerSurfaceRuntime')
      })
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true'), {
        timeout: 15000
      })
      await user.type(screen.getByRole('textbox'), 'industrial video')
      if (entry === '已有会话') {
        await waitFor(() =>
          expect(cacheService.getPersist('industrial_video.session_draft.runtime-video')?.requirement).toBe(
            'industrial video'
          )
        )
      }
      await user.type(screen.getByRole('textbox'), ' updated')
      if (entry === '已有会话') {
        await waitFor(() =>
          expect(cacheService.getPersist('industrial_video.session_draft.runtime-video')?.requirement).toBe(
            'industrial video updated'
          )
        )
      }
      await user.keyboard('{Enter}')
      expect(dataApiService.post).not.toHaveBeenCalled()
      const generate = screen.getByRole('button', { name: i18next.t('industrial_video.generate') })
      expect(generate).toBeDisabled()
      expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: i18next.t('industrial_video.add_material') }))
      await user.click(await screen.findByRole('button', { name: i18next.t('industrial_video.upload') }))
      expect(window.api.file.select).toHaveBeenCalledWith({ properties: ['openFile', 'multiSelections'] })

      await user.click(screen.getByRole('button', { name: i18next.t('industrial_video.select_model') }))
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
    }
  )
})
