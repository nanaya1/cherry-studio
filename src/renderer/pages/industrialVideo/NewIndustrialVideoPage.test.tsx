import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { MockDataApiUtils } from '@test-mocks/renderer/DataApiService'
import { MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { ipcApi } from '@renderer/ipc'
import { Route } from '@renderer/routes/app/industrial-video'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import IndustrialVideoPage from './IndustrialVideoPage'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('../../../../packages/ui/src/components/primitives/button')),
  ...(await import('../../../../packages/ui/src/components/primitives/dialog')),
  ...(await import('../../../../packages/ui/src/components/primitives/input')),
  ...(await import('../../../../packages/ui/src/components/primitives/label')),
  ...(await import('../../../../packages/ui/src/components/primitives/popover')),
  ...(await import('../../../../packages/ui/src/components/primitives/switch')),
  ...(await import('../../../../packages/ui/src/components/primitives/tabs')),
  ...(await import('../../../../packages/ui/src/components/primitives/tooltip'))
}))

// 保持真实数据服务边界，避免导入其开发工具及整套 UI barrel。
vi.mock('@data/DataApiService', async () => {
  const { MockDataApiService } = await import('@test-mocks/renderer/DataApiService')
  return MockDataApiService
})

vi.mock('@renderer/data/hooks/useDataApi', async () => {
  const { MockUseDataApi } = await import('@test-mocks/renderer/useDataApi')
  return MockUseDataApi
})
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))

const mocks = vi.hoisted(() => ({ reuseOrCreateSession: vi.fn() }))
vi.mock('@renderer/hooks/resourceViewSources', () => ({ useAgentSessionsSource: () => mocks }))
// 页面只使用共享按钮样式，不挂载通用工具菜单及其 QuickPanel 依赖。
vi.mock('@renderer/components/composer/ComposerToolRuntime', () => ({
  ComposerActiveToolControls: () => null,
  ComposerToolMenu: () => null
}))
// 编辑器自身已有独立覆盖；此处保留真实路由、Page、Composer 和设置表单。
vi.mock('@renderer/components/composer/ComposerSurface', () => ({
  default: (props: { text: string; onTextChange: (value: string) => void; sendAccessory: React.ReactNode }) => (
    <>
      <textarea aria-label="视频需求" value={props.text} onChange={(event) => props.onTextChange(event.target.value)} />
      {props.sendAccessory}
    </>
  )
}))
vi.mock('@renderer/components/ModelSelector', () => ({
  ModelSelector: ({ trigger }: { trigger: React.ReactNode }) => trigger
}))
vi.mock('@renderer/utils/model', () => ({ readDefaultModel: async () => ({ id: 'test::model', name: '测试模型' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

async function openEntry() {
  const root = createRootRoute()
  const entry = createRoute({
    getParentRoute: () => root,
    path: '/app/industrial-video',
    component: Route.options.component
  })
  const router = createRouter({
    routeTree: root.addChildren([entry]),
    history: createMemoryHistory({ initialEntries: ['/app/industrial-video'] })
  })
  await router.load()
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    )
  })
  return { ...view, router }
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.scrollTo = vi.fn()
  MockCacheUtils.resetMocks()
  MockUseDataApiUtils.resetMocks()
  MockDataApiUtils.resetMocks()
  vi.mocked(dataApiService.get).mockResolvedValue({ id: 'builtin', model: 'test::model', modelName: '测试模型' })
  // vi.mocked(ipcApi.request).mockResolvedValue({ mode: 'started' } as never)
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.get_records') return null as never
    if (channel === 'ai.agent.industrial_video_session.create') return { sessionId: 'video-1' } as never
    if (channel === 'ai.stream.open') return { mode: 'started' } as never
    throw new Error(`未预期接口 ${channel}`)
  })
  MockUseDataApiUtils.mockQueryData('/agents', {
    items: [{ id: 'custom', type: 'claude-code' }, { id: 'builtin', type: 'claude-code', configuration: { builtin_role: 'assistant' } }]
  } as never)
  mocks.reuseOrCreateSession.mockResolvedValue({
    session: { id: 'video-1', featureKind: 'industrial-video' },
    created: true
  })
})

describe('工业视频真实新建路由', () => {
  it('StrictMode 直接进入原型标题、类型、输入和三卡，浏览不创建空任务', async () => {
    const view = await openEntry()
    expect(await screen.findByRole('heading', { name: 'industrial_video.create.marketing' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'industrial_video.marketing' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('')
    for (const sample of ['product', 'assembly', 'technology']) {
      expect(screen.getByRole('button', { name: `industrial_video.sample.${sample}` })).toBeInTheDocument()
    }
    expect(screen.queryByText('industrial_video.service_unavailable')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'industrial_video.create' })).not.toBeInTheDocument()
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
    view.unmount()
    await openEntry()
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
  })

  it('编辑和切换制作类型不提前创建任务，制作提交时才创建工业视频会话', async () => {
    const user = userEvent.setup()
    const view = await openEntry()
    const input = await screen.findByRole('textbox', { name: '视频需求' })
    await user.type(input, '完整视频需求')
    await user.click(screen.getByRole('tab', { name: 'industrial_video.assembly' }))
    expect(screen.getByRole('heading', { name: 'industrial_video.create.assembly' })).toBeVisible()
    expect(input).toHaveValue('完整视频需求')
    expect(screen.getByRole('button', { name: 'industrial_video.generate' })).toBeEnabled()
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
    expect(dataApiService.post).not.toHaveBeenCalled()
    view.unmount()
  })

  it('提交需求后启动普通 Agent 流并进入普通详情，携带设置快照及任务指令', async () => {
    let finishStream!: (value: unknown) => void
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'ai.agent.industrial_video_session.create') return { sessionId: 'video-1' } as never
      return new Promise((resolve) => {
        finishStream = resolve
      }) as never
    })
    const { router } = await openEntry()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: 'industrial_video.generate' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('ai.stream.open', {
        trigger: 'submit-message',
        topicId: buildAgentSessionTopicId('video-1'),
        userMessageParts: expect.arrayContaining([
          // { type: 'text', text: '制作设备宣传片' },
          expect.objectContaining({ type: 'text', text: '制作设备宣传片' }),
          { type: 'text', text: expect.stringContaining('ivideo_') },
          { type: 'text', text: expect.stringContaining('"settings"') }
        ])
      })
    )
    expect(router.state.location.pathname).toBe('/app/industrial-video')
    await act(async () => finishStream({ mode: 'started' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/agents'))
    expect(router.state.location.search).toEqual({ sessionId: 'video-1' })
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
  })

  it('普通流被阻止时保留创建页和需求，不导航或调用旧 runner、付费 IPC', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'ai.agent.industrial_video_session.create') return { sessionId: 'video-1' } as never
      return {
        mode: 'blocked',
        reason: 'agent-session-workspace',
        message: '工作区不可用，请重试'
      } as never
    })
    const { router } = await openEntry()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '保留未发送需求')
    await user.click(screen.getByRole('button', { name: 'industrial_video.generate' }))
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(router.state.location.pathname).toBe('/app/industrial-video')
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('保留未发送需求')
    expect(vi.mocked(ipcApi.request).mock.calls.map(([channel]) => channel)).toEqual([
      'ai.agent.industrial_video_session.create',
      'ai.stream.open'
    ])
  })

  it('所选模型与普通 Assistant 不一致时创建隔离的视频任务，不修改或复用普通 Agent', async () => {
    vi.mocked(dataApiService.get).mockResolvedValue({ id: 'builtin', model: 'other::model', modelName: '实际模型' })
    await openEntry()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '保留所选模型')
    await user.click(screen.getByRole('button', { name: 'industrial_video.generate' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('ai.agent.industrial_video_session.create', {
        modelId: 'test::model',
        agentType: 'claude-code'
      })
    )
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
    expect(dataApiService.patch).not.toHaveBeenCalled()
    expect(ipcApi.request).toHaveBeenCalledWith('ai.stream.open', expect.anything())
  })

  it('已有视频任务重开恢复类型和需求，不创建新任务', async () => {
    cacheService.setPersist('industrial_video.session_draft.existing', {
      requirement: '已有装配需求',
      modelId: null,
      settings: createIndustrialVideoSettings('assembly')
    })
    await act(async () => {
      render(
        <StrictMode>
          <IndustrialVideoPage session={{ id: 'existing', name: '已有任务' } as AgentSessionEntity} />
        </StrictMode>
      )
    })
    expect(screen.getByRole('heading', { name: 'industrial_video.create.assembly' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('已有装配需求')
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
  })

  it('缺少内置 Agent 时回退到首个可用 Agent 创建工业视频会话', async () => {
    MockUseDataApiUtils.mockQueryData('/agents', { items: [{ id: 'custom', type: 'claude-code' }] } as never)
    await openEntry()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '本地需求')
    expect(screen.getByRole('button', { name: 'industrial_video.generate' })).toBeEnabled()
    expect(mocks.reuseOrCreateSession).not.toHaveBeenCalled()
    expect(dataApiService.post).not.toHaveBeenCalled()
  })

  it('Agent 列表后台刷新时仍保留已解析的会话创建能力', async () => {
    MockUseDataApiUtils.mockQueryResult('/agents', {
      data: { items: [{ id: 'builtin', type: 'claude-code', configuration: { builtin_role: 'assistant' } }] } as never,
      isRefreshing: true
    })
    await openEntry()
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '刷新期间的需求')
    expect(screen.getByRole('button', { name: 'industrial_video.generate' })).toBeEnabled()
  })
})
