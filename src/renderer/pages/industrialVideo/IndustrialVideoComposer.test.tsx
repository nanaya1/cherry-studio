import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isSupportedFile } from '@renderer/utils/file'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'

vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('../../../../packages/ui/src/components/primitives/button')),
  ...(await import('../../../../packages/ui/src/components/primitives/dialog')),
  ...(await import('../../../../packages/ui/src/components/primitives/input')),
  ...(await import('../../../../packages/ui/src/components/primitives/label')),
  ...(await import('../../../../packages/ui/src/components/primitives/popover')),
  ...(await import('../../../../packages/ui/src/components/primitives/switch')),
  ...(await import('../../../../packages/ui/src/components/primitives/tooltip')),
  ...(await import('../../../../packages/ui/src/components/composites/sortable'))
}))
// 共享编辑器已有独立测试；此处用文本及附件公开接口验证页面编排。
vi.mock('@renderer/components/composer/ComposerSurface', () => ({
  default: (props: {
    text: string
    onTextChange: (value: string) => void
    renderLeftControls: () => React.ReactNode
    sendAccessory: React.ReactNode
    topContent?: React.ReactNode
    supportedExts: string[]
    collapsedMaxHeight?: string
    setFiles: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>
    tokens: Array<{ id: string; kind: string; label: string }>
    managedTokenKinds: string[]
    onTokensChange: (
      tokens: Array<{ id: string; kind: string; label: string; index: number; textOffset: number }>
    ) => void
  }) => (
    <>
      {props.topContent}
      <textarea
        aria-label="视频需求"
        data-collapsed-max-height={props.collapsedMaxHeight}
        value={props.text}
        onChange={(event) => props.onTextChange(event.target.value)}
      />
      <div data-testid="composer-file-tokens" data-managed-token-kinds={props.managedTokenKinds.join(',')}>
        {props.tokens.map((token) => (
          <button
            type="button"
            key={token.id}
            data-composer-token-kind={token.kind}
            onClick={() =>
              props.onTokensChange(
                props.tokens
                  .filter((item) => item.id !== token.id)
                  .map((item, index) => ({ ...item, index, textOffset: props.text.length }))
              )
            }>
            {token.label}
          </button>
        ))}
      </div>
      {props.renderLeftControls()}
      {props.sendAccessory}
      <button
        type="button"
        onClick={async () => {
          if (await isSupportedFile('/tmp/archive.zip', new Set(props.supportedExts))) {
            props.setFiles((files) => [
              ...files,
              {
                fileTokenSourceId: 'archive-attachment',
                path: '/tmp/archive.zip',
                name: 'archive',
                origin_name: 'archive.zip',
                ext: '.zip',
                size: 20,
                type: 'other'
              } as ComposerAttachment
            ])
          }
        }}>
        选入归档附件
      </button>
    </>
  )
}))
vi.mock('@renderer/components/ModelSelector', () => ({
  ModelSelector: ({ trigger, onSelect }: { trigger: React.ReactNode; onSelect: (value: unknown) => void }) => (
    <>
      {trigger}
      <button type="button" onClick={() => onSelect({ id: 'test::other', name: '另一个模型' })}>
        切换模型
      </button>
    </>
  )
}))
vi.mock('./IndustrialVideoKnowledgePicker', () => ({
  default: ({ onSelect }: { onSelect: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onSelect('knowledge-file-1', '知识库文件.pdf')}>
      选择知识库文件
    </button>
  )
}))
vi.mock('@renderer/utils/model', () => ({
  readDefaultModel: vi.fn(async () => ({ id: 'test::model', name: '测试模型' }))
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'industrial_video.upload': '上传资料',
        'industrial_video.analyze': '前置分析资料（不生产）',
        'industrial_video.continue_successful': '仅使用成功资料继续',
        'industrial_video.material_ready': '已就绪',
        'industrial_video.material_failed': '解析失败'
      })[key] ?? key
  })
}))

import { MockCacheUtils } from '@test-mocks/renderer/CacheService'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { ipcApi } from '@renderer/ipc'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { readDefaultModel } from '@renderer/utils/model'
import type { CacheIndustrialVideoDraft } from '@shared/data/cache/cacheValueTypes'
import { readCherryMeta } from '@shared/data/types/uiParts'

import IndustrialVideoComposer from './IndustrialVideoComposer'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
  vi.mocked(dataApiService.get).mockImplementation(
    async (path) => ({ id: path.slice('/models/'.length), name: '恢复模型' }) as never
  )
  Object.defineProperty(window.api, 'fs', {
    configurable: true,
    value: { readText: vi.fn(async () => '装配工艺：扭矩 20Nm') }
  })
  Object.defineProperty(window.api.file, 'select', { configurable: true, value: vi.fn() })
  Object.defineProperty(window.api.file, 'createInternalEntry', {
    configurable: true,
    value: vi.fn(async ({ path }: { path: string }) => ({ id: `entry:${path}` }))
  })
  Object.defineProperty(window.api.file, 'getPhysicalPath', {
    configurable: true,
    value: vi.fn(async ({ id }: { id: string }) => id.slice('entry:'.length))
  })
  vi.mocked(window.api.file.select).mockResolvedValue([
    { path: '/tmp/manual.txt', name: 'manual', origin_name: 'manual.txt', ext: '.txt', size: 20, type: 'text' }
  ] as never)
  vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
    if (channel === 'industrial_video.get_records') return null as never
    if (channel === 'file.get_metadata') return { kind: 'file', mime: 'text/plain', size: 20 } as never
    if (channel === 'ai.text.generate') {
      const request = input as {
        uniqueModelId: string
        uiMessages: Array<{ parts: Array<{ type: string; text?: string }> }>
      }
      const content = JSON.parse(request.uiMessages[0].parts.find((part) => part.type === 'text')?.text ?? '{}')
      const fileCount = request.uiMessages[0].parts.filter((part) => part.type === 'file').length
      return { text: `${request.uniqueModelId}：${content.requirement}；资料数 ${fileCount}` } as never
    }
    if (channel === 'ai.text.abort') return undefined as never
    throw new Error(`未预期接口 ${channel}`)
  })
})

describe('工业视频页面本地资料闭环', () => {
  it('新建页未配置默认模型时，手动选择后重新进入仍恢复所选模型且不恢复需求', async () => {
    vi.mocked(readDefaultModel).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    const first = render(<IndustrialVideoComposer />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '本次需求')
    await user.click(screen.getByRole('button', { name: '切换模型' }))
    expect(screen.getByText('另一个模型')).toBeVisible()
    first.unmount()

    render(<IndustrialVideoComposer />)
    expect(await screen.findByText('恢复模型')).toBeVisible()
    expect(dataApiService.get).toHaveBeenCalledWith('/models/test::other')
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('')
  })

  it('从未选择模型的新建页使用全局默认模型，但不将兜底记为手动选择', async () => {
    render(<IndustrialVideoComposer />)
    expect(await screen.findByText('测试模型')).toBeVisible()
    expect(cacheService.getPersist('industrial_video.last_model_id')).toBeNull()
  })

  it('已有会话模型优先于工业视频最近选择，并且恢复会话不覆盖最近选择', async () => {
    cacheService.setPersist('industrial_video.last_model_id', 'test::other')
    cacheService.setPersist('industrial_video.session_draft.saved-video', {
      requirement: '',
      modelId: 'test::session',
      settings: createIndustrialVideoSettings('marketing')
    })
    render(<IndustrialVideoComposer sessionId="saved-video" />)
    expect(await screen.findByText('恢复模型')).toBeVisible()
    expect(dataApiService.get).toHaveBeenCalledWith('/models/test::session')
    expect(cacheService.getPersist('industrial_video.last_model_id')).toBe('test::other')
  })

  it('最近选择模型已删除时保持未选择，不静默切换全局默认模型', async () => {
    cacheService.setPersist('industrial_video.last_model_id', 'test::deleted')
    vi.mocked(dataApiService.get).mockResolvedValueOnce(null)
    render(<IndustrialVideoComposer />)
    await waitFor(() => expect(dataApiService.get).toHaveBeenCalledWith('/models/test::deleted'))
    expect(screen.getByText('industrial_video.select_model')).toBeVisible()
    expect(screen.queryByText('测试模型')).not.toBeInTheDocument()
  })

  it('隐藏通道选择且新任务默认使用普通工具链', async () => {
    const onDraftChange = vi.fn()
    render(<IndustrialVideoComposer onDraftChange={onDraftChange} />)
    expect(screen.queryByRole('group', { name: 'industrial_video.orchestration.mode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'industrial_video.orchestration.dedicated' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'industrial_video.orchestration.agent' })).not.toBeInTheDocument()
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ orchestration: 'agent' })))
  })

  it('点击本地知识库后可选择文件，加入资料并关闭选择弹窗', async () => {
    const user = userEvent.setup()
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'knowledge.get_file_path') return '/tmp/知识库文件.pdf'
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'application/pdf', size: 20 } as never
      throw new Error(`未预期接口 ${channel}`)
    })

    render(<IndustrialVideoComposer />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.local_knowledge' }))

    expect(screen.getByRole('dialog', { name: 'industrial_video.local_knowledge' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '选择知识库文件' }))

    const knowledgeToken = await screen.findByText('知识库文件.pdf')
    expect(knowledgeToken.closest('[data-composer-token-kind="file"]')).toBeInTheDocument()
    expect(screen.getByTestId('composer-file-tokens')).toHaveAttribute('data-managed-token-kinds', 'file')
    expect(screen.queryByText('已就绪')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('knowledge.get_file_path', { itemId: 'knowledge-file-1' })
    )
    expect(screen.queryByRole('dialog', { name: 'industrial_video.local_knowledge' })).not.toBeInTheDocument()
  })

  it('提供附件菜单、三个填入示例和动态校验的制作入口，不展示未接入占位', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer sessionId="existing-video" />)
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveAttribute(
      'data-collapsed-max-height',
      'min(180px, 28vh)'
    )
    expect(screen.queryByText('industrial_video.enterprise_unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('industrial_video.service_unavailable')).not.toBeInTheDocument()
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    expect(generate).toBeDisabled()
    // 正式制作入口沿用标准 Button，不绑定成功状态色。
    expect(generate).not.toHaveClass('bg-success')
    expect(screen.queryByRole('button', { name: '上传资料' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    expect(screen.getByRole('button', { name: '上传资料' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'industrial_video.local_knowledge' })).toBeVisible()
    await user.keyboard('{Escape}')
    for (const name of [
      'industrial_video.sample.product',
      'industrial_video.sample.assembly',
      'industrial_video.sample.technology'
    ]) {
      await user.click(screen.getByRole('button', { name }))
      expect(screen.getByRole('dialog', { name })).toBeVisible()
      await user.click(screen.getByRole('button', { name: 'industrial_video.fill_example' }))
      expect(screen.getByRole('textbox', { name: '视频需求' })).not.toHaveValue('')
    }
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
  })
  it('需求、合法设置和模型齐备时无需资料也可提交制作，并在提交期间禁用入口', async () => {
    const user = userEvent.setup()
    let finishStream!: (value: never) => void
    vi.mocked(dataApiService.get).mockResolvedValue({ agentId: 'builtin', model: 'test::model' })
    vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
      if (channel === 'industrial_video.get_records') return null as never
      if (channel === 'industrial_video.config_status') return { configured: true } as never
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'text/plain', size: 20 } as never
      if (channel === 'ai.text.generate') {
        expect(input).toMatchObject({
          uiMessages: [{ parts: [expect.objectContaining({ type: 'text' })] }]
        })
        return { text: '结构化前置分析' } as never
      }
      if (channel === 'industrial_video.run_create') {
        expect(input).toEqual({ sessionId: 'existing-video', baseName: '产品介绍' })
        return { run: 'run-1' } as never
      }
      if (channel === 'ai.stream.open') {
        return new Promise((resolve) => {
          finishStream = resolve
        })
      }
      if (channel === 'industrial_video.parse') {
        expect(input).toEqual({
          sessionId: 'existing-video',
          run: 'run-1',
          texts: [{ text: '产品介绍\n\n结构化前置分析', title: '产品介绍' }],
          media: [],
          logo: null,
          targetDurationS: 30,
          resolution: '1080P',
          ttsEnabled: true,
          subtitleEnabled: true,
          backgroundMusicEnabled: true,
          withAudio: true,
          voice: 'zh-CN-YunjianNeural',
          aspectRatio: '16:9',
          style: 'marketing'
        })
        return new Promise((resolve) => {
          finishStream = resolve
        })
      }
      throw new Error(`未预期接口 ${channel}`)
    })

    render(<IndustrialVideoComposer sessionId="existing-video" />)
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '产品介绍')
    await waitFor(() => expect(generate).toBeEnabled())

    await user.click(generate)
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'ai.stream.open',
        expect.objectContaining({ topicId: 'agent-session:existing-video' })
      )
    )
    expect(generate).toBeDisabled()
    await act(async () => finishStream({ mode: 'started' } as never))
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.parse', expect.anything())
  })

  it('无 session 时委托页面创建视频会话，再用新 session 提交制作', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'new-video')
    const onSessionCreated = vi.fn()
    vi.mocked(dataApiService.get).mockResolvedValue({ model: 'test::model' })
    vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
      if (channel === 'ai.stream.open') return { mode: 'started' } as never
      if (channel === 'industrial_video.get_records') return null as never
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'text/plain', size: 20 } as never
      if (channel === 'industrial_video.config_status') return { configured: true } as never
      if (channel === 'ai.text.generate') return { text: '新任务前置分析' } as never
      if (channel === 'industrial_video.run_create') {
        expect(input).toEqual({ sessionId: 'new-video', baseName: '装配教学' })
        return { run: 'run-new' } as never
      }
      if (channel === 'industrial_video.parse') return { jobId: 'parse-new' } as never
      throw new Error(`未预期接口 ${channel}`)
    })

    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())

    await user.click(generate)

    await waitFor(() => expect(ensureSession).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('ai.stream.open', {
        trigger: 'submit-message',
        topicId: 'agent-session:new-video',
        userMessageParts: expect.arrayContaining([
          // { type: 'text', text: '装配教学' },
          expect.objectContaining({ type: 'text', text: '装配教学' }),
          expect.objectContaining({ type: 'file', filename: 'manual.txt', url: 'file:///tmp/manual.txt' }),
          expect.objectContaining({ type: 'text', text: expect.stringContaining('"settings"') }),
          expect.objectContaining({ type: 'text', text: expect.stringContaining('ivideo_') })
        ])
      })
    )
    expect(onSessionCreated).toHaveBeenCalledWith('new-video')
  })

  it('没有会话创建能力时，即使其他条件满足也保持制作入口禁用', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    expect(screen.getByRole('button', { name: 'industrial_video.generate' })).toBeDisabled()
  })

  it('本地文件像新建任务一样以内联附件展示，不再显示独立状态列表', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    await user.click(screen.getByRole('button', { name: '选入归档附件' }))
    const localToken = await screen.findByText('archive.zip')
    expect(localToken.closest('[data-composer-token-kind="file"]')).toBeInTheDocument()
    expect(screen.getByTestId('composer-file-tokens')).toHaveAttribute('data-managed-token-kinds', 'file')
    expect(screen.queryByText('已就绪')).not.toBeInTheDocument()
    expect(screen.queryByText('解析失败')).not.toBeInTheDocument()
  })

  it('按会话恢复需求、模型 ID 与资料/Logo（草稿持久化），不恢复活动任务或分析结果', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoComposer sessionId="session-a" />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '会话甲需求')
    await user.click(screen.getByRole('button', { name: '切换模型' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    view.unmount()
    const other = render(<IndustrialVideoComposer sessionId="session-b" />)
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '会话乙需求')
    expect(cacheService.getPersist('industrial_video.session_draft.session-b')?.requirement).toBe('会话乙需求')
    other.unmount()
    render(<IndustrialVideoComposer sessionId="session-a" />)
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('会话甲需求')
    await waitFor(() =>
      expect(cacheService.getPersist('industrial_video.session_draft.session-a')!.modelId).toBe('test::other')
    )
    // 资料与附件现在从草稿持久化恢复。
    expect(screen.getByText('manual.txt')).toBeInTheDocument()
    // 资料可选，恢复需求与模型后允许仅按需求分析。
    expect(screen.getByRole('button', { name: '前置分析资料（不生产）' })).toBeEnabled()
    const saved = cacheService.getPersist('industrial_video.session_draft.session-a')!
    expect(saved.requirement).toBe('会话甲需求')
    expect(saved.modelId).toBe('test::other')
    expect(Object.keys(saved).sort()).toEqual([
      'attachments',
      'materials',
      'modelId',
      'orchestration',
      'requirement',
      'settings'
    ])
    expect(JSON.stringify(saved)).not.toContain('扭矩')
  })

  it('非法时长不经 JSON 变成 null，并恢复合法设置', async () => {
    const user = userEvent.setup()
    const view = render(
      <IndustrialVideoComposer
        sessionId="invalid-duration"
        settings={{ ...createIndustrialVideoSettings('assembly'), duration: Number.NaN }}
      />
    )
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '保留需求')
    const saved = JSON.parse(JSON.stringify(cacheService.getPersist('industrial_video.session_draft.invalid-duration')))
    expect(saved.requirement).toBe('保留需求')
    expect(Number.isFinite(saved.settings.duration)).toBe(true)
    expect(saved.settings.duration).toBeGreaterThan(0)
    view.unmount()
  })

  it('当前实际设置进入前置分析快照', async () => {
    const user = userEvent.setup()
    const settings = { ...createIndustrialVideoSettings('assembly'), duration: 120, ratio: '9:16' as const }
    render(<IndustrialVideoComposer settings={settings} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    await user.click(screen.getByRole('button', { name: '前置分析资料（不生产）' }))
    const request = vi.mocked(ipcApi.request).mock.calls.find(([channel]) => channel === 'ai.text.generate')?.[1]
    const textPart = (
      request as { uiMessages: Array<{ parts: Array<{ type: string; text?: string }> }> }
    ).uiMessages[0].parts.find((part) => part.type === 'text')
    expect(JSON.parse(textPart?.text ?? '{}').settings).toEqual(settings)
  })

  it('示例先预览，确认使用后才填入需求，且不提交、不清除已有资料', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    const requirement = screen.getByRole('textbox', { name: '视频需求' })
    await user.click(screen.getByRole('button', { name: 'industrial_video.sample.product' }))
    expect(screen.getByRole('dialog', { name: 'industrial_video.sample.product' })).toBeVisible()
    expect(requirement).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'industrial_video.fill_example' }))
    expect(requirement).toHaveValue('industrial_video.example.marketing')
    expect(screen.getByText('manual.txt')).toBeInTheDocument()
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
  })

  it('超过 600 秒禁止分析，修正后可以分析', async () => {
    const user = userEvent.setup()
    const settings = { ...createIndustrialVideoSettings('marketing'), duration: 601 }
    const view = render(<IndustrialVideoComposer settings={settings} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '产品介绍')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    expect(screen.getByRole('button', { name: '前置分析资料（不生产）' })).toBeDisabled()
    view.rerender(<IndustrialVideoComposer settings={{ ...settings, duration: 600 }} />)
    expect(screen.getByRole('button', { name: '前置分析资料（不生产）' })).toBeEnabled()
  })

  it('Logo 可添加、替换、确认移除，不作为资料解析或提交', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    const input = screen.getByLabelText('industrial_video.logo', { selector: 'input[type="file"]' })
    await user.upload(input, new File(['first'], 'first.png', { type: 'image/png' }))
    expect(await screen.findByRole('button', { name: 'industrial_video.logo: first.png' })).toBeInTheDocument()
    await user.upload(input, new File(['second'], 'second.png', { type: 'image/png' }))
    expect(await screen.findByRole('button', { name: 'industrial_video.logo: second.png' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'industrial_video.logo: first.png' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'industrial_video.remove_logo' }))
    expect(screen.queryByRole('button', { name: 'industrial_video.logo: second.png' })).not.toBeInTheDocument()
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
  })

  it('指定 Logo 按钮 hover 显示上传说明 tooltip', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    const trigger = screen.getByRole('button', { name: 'industrial_video.logo' })
    await user.hover(trigger)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('industrial_video.logo_tooltip')
  })

  it('未选择分析模型时提示选择模型，不发起附件分析', async () => {
    const user = userEvent.setup()
    vi.mocked(readDefaultModel).mockResolvedValueOnce(undefined)
    render(<IndustrialVideoComposer />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')

    await user.click(screen.getByRole('button', { name: '前置分析资料（不生产）' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('industrial_video.select_model')
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
  })

  // 防止分析等待无反馈、结束后覆盖用户需求，以及失败后加载状态不恢复。
  it.each(['success', 'failure'] as const)('前置分析局部加载并在 %s 后恢复，结果不回填需求', async (outcome) => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    let fail!: (reason: Error) => void
    vi.mocked(ipcApi.request).mockImplementation((channel) => {
      if (channel === 'ai.text.generate')
        return new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }) as never
      return Promise.resolve(undefined as never)
    })
    render(<IndustrialVideoComposer />)
    const input = screen.getByRole('textbox', { name: '视频需求' })
    await user.type(input, '原始视频需求')
    await user.click(screen.getByRole('button', { name: '前置分析资料（不生产）' }))
    expect(await screen.findByRole('status')).toHaveTextContent('industrial_video.analyzing')
    await waitFor(() => expect(finish).toBeDefined())
    await act(async () => {
      if (outcome === 'success') finish({ text: '独立分析结果' })
      else fail(new Error('分析服务失败'))
    })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(input).toHaveValue('原始视频需求')
    if (outcome === 'success')
      expect(screen.getByRole('region', { name: 'industrial_video.analysis_result' })).toHaveTextContent('独立分析结果')
    else expect(screen.getByRole('alert')).toHaveTextContent('分析服务失败')
  })

  it('取消润色后移除局部加载并保留原文，晚返回不覆盖', async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    vi.mocked(ipcApi.request).mockImplementation((channel) => {
      if (channel === 'ai.text.generate')
        return new Promise((resolve) => {
          finish = resolve
        }) as never
      return Promise.resolve(undefined as never)
    })
    render(<IndustrialVideoComposer />)
    const input = screen.getByRole('textbox', { name: '视频需求' })
    await user.type(input, '保留原文')
    await user.click(screen.getByRole('button', { name: 'library.config.prompt.polish' }))
    expect(await screen.findByRole('status')).toHaveTextContent('library.config.prompt.polish')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => finish({ text: '已取消的润色' }))
    expect(input).toHaveValue('保留原文')
  })

  it('润色携带当前制作设置、保持原需求并可撤销，不触发资料分析或生产', async () => {
    const user = userEvent.setup()
    const requirement = '面向客户制作30秒输送系统宣传视频，先展示设备整体，再突出稳定输送与应用场景。'
    const brief = '制作一段面向客户的30秒输送系统宣传视频，先展示整体，再呈现稳定输送及真实应用场景。'
    const settings = {
      ...createIndustrialVideoSettings('marketing'),
      ratio: '9:16' as const,
      resolution: '720P' as const,
      voice: '无旁白' as const,
      backgroundMusic: false,
      subtitle: false,
      withAudio: false
    }
    vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
      if (channel === 'ai.text.generate') {
        const request = input as { prompt: string; system: string }
        expect(request.prompt).toBe(requirement)
        expect(request.system).toContain(JSON.stringify(settings))
        expect(request.system).toContain('制作简报')
        return { text: brief } as never
      }
      throw new Error(`润色不应触发其他接口：${channel}`)
    })
    render(<IndustrialVideoComposer settings={settings} />)
    await screen.findByText('测试模型')
    const input = screen.getByRole('textbox', { name: '视频需求' })
    await user.type(input, requirement)
    await user.click(screen.getByRole('button', { name: 'library.config.prompt.polish' }))
    await waitFor(() => expect(input).toHaveValue(brief))
    await user.click(screen.getByRole('button', { name: 'common.undo' }))
    expect(input).toHaveValue(requirement)
  })

  it('制作设置变化后丢弃旧配置润色的迟到结果', async () => {
    const user = userEvent.setup()
    let finish!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementation((channel) => {
      if (channel === 'ai.text.generate') {
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      return Promise.resolve(undefined as never)
    })
    const settings = createIndustrialVideoSettings('marketing')
    const view = render(<IndustrialVideoComposer settings={settings} />)
    await screen.findByText('测试模型')
    const input = screen.getByRole('textbox', { name: '视频需求' })
    await user.type(input, '输送系统宣传视频')
    await user.click(screen.getByRole('button', { name: 'library.config.prompt.polish' }))
    await waitFor(() => expect(finish).toBeDefined())
    view.rerender(<IndustrialVideoComposer settings={{ ...settings, ratio: '9:16' }} />)
    await act(async () => finish({ text: '旧16:9简报' } as never))
    expect(input).toHaveValue('输送系统宣传视频')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('未显式选中模型时仍可使用默认模型润色提示词', async () => {
    const user = userEvent.setup()
    vi.mocked(readDefaultModel).mockResolvedValueOnce(undefined)
    vi.mocked(ipcApi.request).mockResolvedValueOnce({ text: '润色后的需求' })

    render(<IndustrialVideoComposer />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '原需求')

    const polish = screen.getByRole('button', { name: 'library.config.prompt.polish' })
    expect(polish).toBeEnabled()
    await user.click(polish)

    await waitFor(() => expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('润色后的需求'))
    expect(ipcApi.request).toHaveBeenCalledWith(
      'ai.text.generate',
      expect.objectContaining({ prompt: '原需求', system: expect.stringContaining('industrial_video.polish_prompt') })
    )
  })

  it('润色先启动时不能并发分析；润色返回后只分析新需求，修改源内容清除旧分析', async () => {
    const user = userEvent.setup()
    let finishPolish!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementation((channel, input) => {
      if (channel === 'file.get_metadata')
        return Promise.resolve({ kind: 'file', mime: 'text/plain', size: 20 } as never)
      if (channel === 'ai.text.generate') {
        const request = input as {
          system: string
          prompt?: string
          uiMessages?: Array<{ parts: Array<{ type: string; text?: string }> }>
        }
        if (request.prompt !== undefined) {
          return new Promise((resolve) => {
            finishPolish = resolve
          })
        }
        const textPart = request.uiMessages?.[0].parts.find((part) => part.type === 'text')
        return Promise.resolve({ text: `分析：${JSON.parse(textPart?.text ?? '{}').requirement}` } as never)
      }
      return Promise.resolve(undefined as never)
    })
    vi.mocked(window.api.file.select).mockResolvedValue([
      { path: '/tmp/manual.txt', name: 'manual', origin_name: 'manual.txt', ext: '.txt', size: 20, type: 'text' }
    ] as never)
    render(<IndustrialVideoComposer />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '原需求')
    const analyze = screen.getByRole('button', { name: '前置分析资料（不生产）' })
    await user.click(screen.getByRole('button', { name: 'library.config.prompt.polish' }))
    await waitFor(() => expect(finishPolish).toBeDefined())
    expect(analyze).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('library.config.prompt.polish')
    await user.click(analyze)
    expect(screen.queryByText('分析：原需求')).not.toBeInTheDocument()
    await act(async () => finishPolish({ text: '新需求' } as never))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('新需求'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await waitFor(() => expect(analyze).toBeEnabled())
    await user.click(analyze)
    await screen.findByText('分析：新需求')
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '变更')
    expect(screen.queryByRole('region', { name: 'industrial_video.analysis_result' })).not.toBeInTheDocument()
  })

  it.each(['设置', '模型', '移除材料', '添加材料'])('%s变化立即清除旧分析', async (source) => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoComposer settingsKey="old" />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    await user.click(screen.getByRole('button', { name: '前置分析资料（不生产）' }))
    await screen.findByText('test::model：装配教学；资料数 1')
    if (source === '设置') view.rerender(<IndustrialVideoComposer settingsKey="new" />)
    else if (source === '模型') await user.click(screen.getByRole('button', { name: '切换模型' }))
    else if (source === '移除材料') {
      const manualToken = screen.getByText('manual.txt').closest('[data-composer-token-kind="file"]')
      expect(manualToken).not.toBeNull()
      await user.click(manualToken!)
    } else {
      vi.mocked(window.api.file.select).mockResolvedValue([
        {
          fileTokenSourceId: 'new-material',
          path: '/tmp/new.txt',
          name: 'new',
          origin_name: 'new.txt',
          ext: '.txt',
          size: 20,
          type: 'text'
        }
      ] as never)
      await waitFor(() => expect(screen.getByRole('button', { name: 'industrial_video.add_material' })).toBeEnabled())
      await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
      await user.click(screen.getByRole('button', { name: '上传资料' }))
      await screen.findByText('new.txt')
    }
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'industrial_video.analysis_result' })).not.toBeInTheDocument()
    )
  })

  /* 通道选择入口已暂停，保留原入口测试供恢复。
  it('专用编排选项创建独立任务并直接解析，不启动 Agent 工具链', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'dedicated-video')
    const onSessionCreated = vi.fn()
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.config_status') return { configured: true } as never
      if (channel === 'industrial_video.get_records') return null as never
      if (channel === 'ai.text.generate') return { text: '设备资料分析' } as never
      if (channel === 'industrial_video.run_create') return { run: 'dedicated-run' } as never
      if (channel === 'industrial_video.parse') return { jobId: 'parse-job' } as never
      throw new Error(`Unexpected ${channel}`)
    })
    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.orchestration.dedicated' }))
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '设备介绍')
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    await waitFor(() =>
      expect(cacheService.getPersist('industrial_video.preparation.dedicated-video')?.stage).toBe('submitted')
    )
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({ orchestration: 'dedicated' }))
    expect(onSessionCreated).toHaveBeenCalledWith('dedicated-video')
    expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'ai.stream.open')).toBe(false)
  })

  */

  /* 原 runner 合约已停用，保留替换前测试供追溯。
  it('点击制作保存完整草稿并立即跳转详情，runner 后台执行且完成后仅 parse 一次', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'new-video')
    const onSessionCreated = vi.fn()
    let finishAI!: (value: unknown) => void
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return null as never
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'text/plain', size: 20 } as never
      if (channel === 'industrial_video.config_status') return { configured: true } as never
      if (channel === 'industrial_video.upload') return { name: 'first.png' } as never
      if (channel === 'ai.text.generate') {
        // 让 runner 停在资料分析阶段，验证 onSessionCreated 与草稿保存的时序。
        return new Promise((resolve) => {
          finishAI = resolve
        }) as never
      }
      if (channel === 'industrial_video.run_create') return { run: 'run-new' } as never
      if (channel === 'industrial_video.parse') return { jobId: 'parse-new' } as never
      throw new Error(`未预期接口 ${channel}`)
    })

    const view = render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    const manualToken = await screen.findByText('manual.txt')
    expect(manualToken).toBeInTheDocument()
    const logoInput = screen.getByLabelText('industrial_video.logo', { selector: 'input[type="file"]' })
    await user.upload(logoInput, new File(['first'], 'first.png', { type: 'image/png' }))
    expect(await screen.findByRole('button', { name: 'industrial_video.logo: first.png' })).toBeInTheDocument()
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())

    await user.click(generate)

    // 仍在 ai.text.generate 时，onSessionCreated 已触发（runner 同步保存草稿后即可跳转）。
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('new-video'))
    const saved = cacheService.getPersist('industrial_video.session_draft.new-video')
    expect(saved?.requirement).toBe('装配教学')
    expect(saved?.attachments?.some((a) => a.origin_name === 'manual.txt' || a.name === 'manual')).toBe(true)
    expect(saved?.materials?.some((m) => m.name === 'manual.txt')).toBe(true)
    await waitFor(() => expect(finishAI).toBeDefined())
    expect(saved?.logo?.name).toBe('first.png')

    // 卸载后使用同一 sessionId 渲染应当恢复需求、素材与 Logo。
    view.unmount()
    const restored = render(<IndustrialVideoComposer sessionId="new-video" />)
    expect(await restored.findByText('manual.txt')).toBeInTheDocument()
    expect(restored.getByRole('button', { name: 'industrial_video.logo: first.png' })).toBeInTheDocument()
    expect(restored.getByRole('textbox', { name: '视频需求' })).toHaveValue('装配教学')

    // 完成 AI 分析后，仅 parse 一次，且不发起 abort。
    await act(async () => {
      finishAI({ text: '原始资料分析' })
    })
    await waitFor(() => expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.parse', expect.anything()))
    expect(
      vi.mocked(ipcApi.request).mock.calls.filter(([channel]) => channel === 'industrial_video.parse')
    ).toHaveLength(1)
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.abort', expect.anything())
  })

  */

  it('完整设置、Logo 和附件进入普通流，ack 成功后才导航且不执行旧 runner 或付费 IPC', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn<(draft: CacheIndustrialVideoDraft) => Promise<string>>().mockResolvedValue('new-video')
    const onSessionCreated = vi.fn()
    const settings = {
      ...createIndustrialVideoSettings('assembly'),
      duration: 45,
      ratio: '9:16' as const,
      resolution: '720P' as const,
      style: '科技' as const,
      voice: '正式男声' as const,
      backgroundMusic: true,
      subtitle: false,
      withAudio: false
    }
    let finishStream!: (value: unknown) => void
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'text/plain', size: 20 } as never
      if (channel === 'industrial_video.upload') return { name: 'uploaded-logo.png' } as never
      if (channel === 'ai.stream.open') {
        return new Promise((resolve) => {
          finishStream = resolve
        }) as never
      }
      throw new Error(`未预期接口 ${channel}`)
    })
    render(
      <IndustrialVideoComposer settings={settings} ensureSession={ensureSession} onSessionCreated={onSessionCreated} />
    )
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    await user.upload(
      screen.getByLabelText('industrial_video.logo', { selector: 'input[type="file"]' }),
      new File(['first'], 'first.png', { type: 'image/png' })
    )
    await screen.findByRole('button', { name: 'industrial_video.logo: first.png' })
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    await waitFor(() => expect(finishStream).toBeDefined())
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(generate).toBeDisabled()
    expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.upload', {
      sessionId: 'new-video',
      name: expect.stringMatching(/^logo-[0-9a-f-]+\.png$/),
      content: new Uint8Array([102, 105, 114, 115, 116])
    })
    const input = ensureSession.mock.calls[0][0]
    expect(input).toEqual(
      expect.objectContaining({
        requirement: '装配教学',
        modelId: 'test::model',
        settings,
        logo: { name: 'first.png', source: expect.stringMatching(/^data:image\/png;base64,/) },
        attachments: [expect.objectContaining({ origin_name: 'manual.txt', path: '/tmp/manual.txt' })],
        materials: [expect.objectContaining({ name: 'manual.txt', status: 'ready' })]
      })
    )
    const stream = vi.mocked(ipcApi.request).mock.calls.find(([channel]) => channel === 'ai.stream.open')?.[1]
    expect(stream).toEqual({
      trigger: 'submit-message',
      topicId: buildAgentSessionTopicId('new-video'),
      userMessageParts: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: '装配教学' }),
        expect.objectContaining({ type: 'file', filename: 'manual.txt' }),
        expect.objectContaining({
          type: 'text',
          text: JSON.stringify({
            settings,
            modelId: input.modelId,
            media: [],
            logo: { name: 'uploaded-logo.png' }
          }),
          providerMetadata: {
            cherry: {
              displayText: expect.stringContaining('45 industrial_video.seconds · 9:16 · 720P · 科技 · 正式男声')
            }
          }
        }),
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('ivideo_'),
          providerMetadata: { cherry: { displayText: '' } }
        })
      ])
    })
    // if (!stream || !('userMessageParts' in stream)) throw new Error('缺少普通流消息')
    if (!stream || typeof stream !== 'object' || !('userMessageParts' in stream)) throw new Error('缺少普通流消息')
    const parts = stream.userMessageParts!
    const textParts = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(textParts).not.toContain('base64')
    expect(textParts).not.toContain('/tmp/manual.txt')
    expect(textParts).not.toContain('"source"')
    const filePart = parts.find((part) => part.type === 'file')!
    const sourceId = readCherryMeta(filePart)?.fileTokenSourceId
    expect(sourceId).toBe(input.attachments![0].fileTokenSourceId)
    // expect(readCherryMeta(parts[0])?.composer).toEqual({
    const firstPart = parts[0]
    if (firstPart.type !== 'text') throw new Error('首个消息片段不是文本')
    expect(readCherryMeta(firstPart)?.composer).toEqual({
      version: 1,
      tokens: [
        {
          id: `file:${sourceId}`,
          kind: 'file',
          label: 'manual.txt',
          index: 0,
          textOffset: 0
        }
      ]
    })
    expect(cacheService.getPersist('industrial_video.preparation.new-video')).toBeNull()
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.text.generate', expect.anything())
    expect(vi.mocked(ipcApi.request).mock.calls.map(([channel]) => channel)).toEqual([
      'file.get_metadata',
      'file.get_metadata',
      'industrial_video.upload',
      'ai.stream.open'
    ])
    await user.click(generate)
    expect(ensureSession).toHaveBeenCalledTimes(1)
    await act(async () => finishStream({ mode: 'started' }))
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith('new-video'))
  })

  it('就绪图片和视频先上传，再将返回句柄交给普通流，附件仍用于模型分析', async () => {
    const user = userEvent.setup()
    const ensureSession = vi
      .fn<(draft: CacheIndustrialVideoDraft) => Promise<string>>()
      .mockResolvedValue('media-video')
    const onSessionCreated = vi.fn()
    vi.mocked(window.api.file.select).mockResolvedValue([
      { path: '/tmp/photo.png', name: 'photo', origin_name: 'photo.png', ext: '.png', size: 20, type: 'image' },
      { path: '/tmp/demo.mp4', name: 'demo', origin_name: 'demo.mp4', ext: '.mp4', size: 20, type: 'video' }
    ] as never)
    vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'application/octet-stream', size: 20 } as never
      if (channel === 'file.read') return { content: [1, 2, 3] } as never
      if (channel === 'industrial_video.upload') {
        expect(ensureSession).toHaveResolvedWith('media-video')
        expect(onSessionCreated).not.toHaveBeenCalled()
        const upload = input as { sessionId: string; name: string; content: Uint8Array }
        expect(upload.sessionId).toBe('media-video')
        expect(upload.content).toEqual(new Uint8Array([1, 2, 3]))
        return { name: `server-${upload.name}` } as never
      }
      if (channel === 'ai.stream.open') return { mode: 'started' } as never
      throw new Error(`未预期接口 ${channel}`)
    })
    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('demo.mp4')
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('media-video'))
    const calls = vi.mocked(ipcApi.request).mock.calls
    const stream = calls.find(([channel]) => channel === 'ai.stream.open')?.[1]
    // if (!stream || !('userMessageParts' in stream)) throw new Error('缺少普通流消息')
    if (!stream || typeof stream !== 'object' || !('userMessageParts' in stream)) throw new Error('缺少普通流消息')
    expect(stream.userMessageParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'file', filename: 'photo.png' }),
        expect.objectContaining({ type: 'file', filename: 'demo.mp4' })
      ])
    )
    const snapshot = stream.userMessageParts?.find((part) => part.type === 'text' && part.text.startsWith('{'))
    expect(snapshot?.type === 'text' && JSON.parse(snapshot.text)).toEqual({
      settings: ensureSession.mock.calls[0][0]?.settings,
      modelId: 'test::model',
      media: [
        { name: 'server-photo.png', caption: 'photo.png' },
        { name: 'server-demo.mp4', caption: 'demo.mp4' }
      ],
      logo: null
    })
    expect(calls.filter(([channel]) => channel.startsWith('industrial_video.')).map(([channel]) => channel)).toEqual([
      'industrial_video.upload',
      'industrial_video.upload'
    ])
    expect(calls.slice(-1)[0][0]).toBe('ai.stream.open')
  })

  it.each(['媒体', 'Logo'])('%s上传失败显示真实错误，不打开普通流且不导航', async (source) => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'failed-upload')
    const onSessionCreated = vi.fn()
    vi.mocked(window.api.file.select).mockResolvedValue([
      { path: '/tmp/photo.png', name: 'photo', origin_name: 'photo.png', ext: '.png', size: 20, type: 'image' }
    ] as never)
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'file.get_metadata') return { kind: 'file', mime: 'image/png', size: 20 } as never
      if (channel === 'file.read') return { content: [1, 2, 3] } as never
      if (channel === 'industrial_video.upload') throw new Error('上传服务拒绝：存储空间不足')
      if (channel === 'ai.stream.open') return { mode: 'started' } as never
      throw new Error(`未预期接口 ${channel}`)
    })
    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    if (source === '媒体') {
      await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
      await user.click(screen.getByRole('button', { name: '上传资料' }))
      await screen.findByText('photo.png')
    } else {
      await user.upload(
        screen.getByLabelText('industrial_video.logo', { selector: 'input[type="file"]' }),
        new File(['logo'], 'logo.png', { type: 'image/png' })
      )
      await screen.findByRole('button', { name: 'industrial_video.logo: logo.png' })
    }
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    expect(await screen.findByRole('alert')).toHaveTextContent('上传服务拒绝：存储空间不足')
    expect(ipcApi.request).not.toHaveBeenCalledWith('ai.stream.open', expect.anything())
    expect(onSessionCreated).not.toHaveBeenCalled()
    await waitFor(() => expect(generate).toBeEnabled())
  })

  it('无素材或 Logo 时无需上传，正常打开普通流并导航', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'empty-video')
    const onSessionCreated = vi.fn()
    vi.mocked(ipcApi.request).mockResolvedValue({ mode: 'started' })
    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('empty-video'))
    expect(vi.mocked(ipcApi.request).mock.calls.map(([channel]) => channel)).toEqual(['ai.stream.open'])
    expect(ipcApi.request).toHaveBeenCalledWith(
      'ai.stream.open',
      expect.objectContaining({
        userMessageParts: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: JSON.stringify({
              settings: createIndustrialVideoSettings('marketing'),
              modelId: 'test::model',
              media: [],
              logo: null
            })
          })
        ])
      })
    )
  })

  it('普通流 blocked 时显示错误、不导航且允许重试，不执行旧 runner 或付费 IPC', async () => {
    const user = userEvent.setup()
    const ensureSession = vi.fn(async () => 'blocked-video')
    const onSessionCreated = vi.fn()
    vi.mocked(ipcApi.request).mockResolvedValue({
      mode: 'blocked',
      reason: 'agent-session-workspace',
      message: '工作区不可用，请重试'
    })
    render(<IndustrialVideoComposer ensureSession={ensureSession} onSessionCreated={onSessionCreated} />)
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '保留需求')
    const generate = screen.getByRole('button', { name: 'industrial_video.generate' })
    await waitFor(() => expect(generate).toBeEnabled())
    await user.click(generate)
    expect(await screen.findByRole('alert')).toHaveTextContent('工作区不可用，请重试')
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveValue('保留需求')
    await waitFor(() => expect(generate).toBeEnabled())
    expect(vi.mocked(ipcApi.request).mock.calls.map(([channel]) => channel)).toEqual(['ai.stream.open'])
    expect(cacheService.getPersist('industrial_video.preparation.blocked-video')).toBeNull()
  })

  it('附件就绪后通过标准 UI 消息进入当前模型分析，不在页面层读取正文', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoComposer />)
    const analyze = screen.getByRole('button', { name: '前置分析资料（不生产）' })
    expect(analyze).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '装配教学')
    await user.click(screen.getByRole('button', { name: 'industrial_video.add_material' }))
    await user.click(screen.getByRole('button', { name: '上传资料' }))
    await screen.findByText('manual.txt')
    await waitFor(() => expect(analyze).toBeEnabled())
    await user.click(analyze)
    await screen.findByText('test::model：装配教学；资料数 1')
    expect(window.api.fs.readText).not.toHaveBeenCalled()
    const request = vi.mocked(ipcApi.request).mock.calls.find(([channel]) => channel === 'ai.text.generate')?.[1]
    expect(request).toEqual(
      expect.objectContaining({
        uniqueModelId: 'test::model',
        uiMessages: [
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([expect.objectContaining({ type: 'file', filename: 'manual.txt' })])
          })
        ]
      })
    )
  })
})
