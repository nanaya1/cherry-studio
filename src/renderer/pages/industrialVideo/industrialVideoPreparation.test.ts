import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { loggerService } from '@logger'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { AbsoluteFilePathSchema } from '@shared/types/file'

import {
  isIndustrialVideoPreparing,
  startIndustrialVideoPreparation,
  type IndustrialVideoPreparationInput
} from './industrialVideoPreparation'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

// 统一 IPC mock：所有工业视频通道与 ai.text.generate 在此可控返回。
const ipcMock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: ipcMock }))

// 隔离上传实现（其内部依赖 window.api.file，与 pipeline 合约无关）。
vi.mock('./industrialVideoWorkflow', () => ({
  uploadIndustrialMedia: vi.fn(async (_sessionId: string, _path: string, name: string) => ({ name: `up-${name}` })),
  uploadIndustrialLogo: vi.fn(async (_sessionId: string, name: string) => ({ name: `up-${name}` }))
}))

// 隔离附件转 FileUIPart 的实现，仅校验 runner 是否按 attachments 调用。
vi.mock('@renderer/utils/file/buildFileParts', () => ({
  buildFilePartsForAttachments: vi.fn(async (attachments: any[]) =>
    attachments.map((attachment, index) => ({
      type: 'file',
      mediaType: 'application/octet-stream',
      url: `file://${attachment.path}`,
      filename: attachment.name,
      providerMetadata: { cherry: { fileTokenSourceId: attachment.fileTokenSourceId ?? `src-${index}` } }
    }))
  )
}))

const TEST_MODEL = { id: 'test::prepare-model', name: '准备分析模型', providerId: 'test' } as any

function baseDraft(
  overrides: Partial<IndustrialVideoPreparationInput['draft']> = {}
): IndustrialVideoPreparationInput['draft'] {
  return {
    requirement: '一条工业产品宣传视频需求',
    modelId: 'test::prepare-model',
    settings: createIndustrialVideoSettings('marketing'),
    attachments: [
      {
        fileTokenSourceId: 'src-a',
        path: AbsoluteFilePathSchema.parse('/tmp/industrial/附件.png'),
        name: '附件.png',
        origin_name: '附件.png',
        ext: '.png',
        size: 1024,
        type: 'image'
      },
      {
        fileTokenSourceId: 'src-b',
        path: AbsoluteFilePathSchema.parse('/tmp/industrial/素材.mp4'),
        name: '素材.mp4',
        origin_name: '素材.mp4',
        ext: '.mp4',
        size: 2048,
        type: 'video'
      }
    ],
    logo: { name: 'logo.png', source: 'data:image/png;base64,AAAA' },
    ...overrides
  }
}

function channelCalls(channel: string) {
  return ipcMock.request.mock.calls.filter(([c]) => c === channel)
}

beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
  // 解析分析模型：草稿携带 modelId，命中 dataApiService.get('/models/...')。
  vi.mocked(dataApiService.get).mockImplementation(async (path: string) =>
    path.startsWith('/models/') ? TEST_MODEL : undefined
  )
  ipcMock.request.mockImplementation(async (channel: string) => {
    if (channel === 'industrial_video.config_status') return { configured: true }
    if (channel === 'ai.text.generate') return { text: '{"analysis":"ok"}' }
    if (channel === 'industrial_video.run_create') return { run: 'run-1' }
    if (channel === 'industrial_video.parse') return {}
    return undefined
  })
})

afterEach(() => {
  MockCacheUtils.resetMocks()
})

describe('工业视频准备任务 runner', () => {
  it.each(['industrial_video.run_create', 'industrial_video.parse'])(
    '诊断 %s 失败且不泄露正文、路径和原始错误数据',
    async (failedOperation) => {
      const errorLog = vi
        .spyOn(loggerService.withContext('industrial-video-preparation'), 'error')
        .mockImplementation(() => {})
      const original = ipcMock.request.getMockImplementation()!
      ipcMock.request.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === failedOperation) {
          throw new IpcError('VALIDATION_FAILED', '参数校验失败 private-body', {
            status: 422,
            code: 'invalid_params',
            issues: [{ path: ['voice'], code: 'invalid_value', message: 'private-body', input: 'secret-token' }],
            authorization: 'secret-token'
          })
        }
        return original(channel, ...args)
      })
      await startIndustrialVideoPreparation(
        'diagnostic',
        { draft: baseDraft({ requirement: 'private-body' }) },
        'secret-prompt'
      )
      const diagnostic = errorLog.mock.calls.at(-1)?.[1]
      expect(diagnostic).toMatchObject({
        sessionId: 'diagnostic',
        operation: failedOperation,
        code: 'VALIDATION_FAILED',
        status: 422,
        serverCode: 'invalid_params',
        issues: [{ path: ['voice'], code: 'invalid_value' }],
        params: { requirementLength: 12, attachmentCount: 2, targetDurationS: 30, resolution: '1080P' }
      })
      expect(errorLog.mock.calls.at(-1)?.[1]).not.toHaveProperty('logToMain')
      expect(errorLog.mock.calls.at(-1)?.[2]).toEqual({ logToMain: true })
      const serialized = JSON.stringify(errorLog.mock.calls)
      for (const secret of ['private-body', 'secret-token', 'secret-prompt', '/tmp/industrial', '附件.png']) {
        expect(serialized).not.toContain(secret)
      }
      expect(cacheService.getPersist('industrial_video.preparation.diagnostic')?.stage).toBe('failed')
      expect(cacheService.getPersist('industrial_video.preparation.diagnostic')?.error).toContain(failedOperation)
      expect(cacheService.getPersist('industrial_video.preparation.diagnostic')?.error).toContain('voice')
      expect(channelCalls(failedOperation)).toHaveLength(1)
      errorLog.mockRestore()
    }
  )

  it('pending generate 时同 session 第二次调用返回同一 Promise，不会重复执行', async () => {
    const input = { draft: baseDraft() }
    const p1 = startIndustrialVideoPreparation('dedup-session', input, 'system-prompt')
    const p2 = startIndustrialVideoPreparation('dedup-session', input, 'system-prompt')
    expect(p2).toBe(p1)
    expect(isIndustrialVideoPreparing('dedup-session')).toBe(true)
    await p1
    expect(isIndustrialVideoPreparing('dedup-session')).toBe(false)
    // 每个 IPC 通道至多一次，generate/parse 不重复。
    expect(channelCalls('ai.text.generate')).toHaveLength(1)
    expect(channelCalls('industrial_video.parse')).toHaveLength(1)
    // 不在组件生命周期内，也绝不触发付费生成或中断。
    expect(channelCalls('industrial_video.video_start')).toHaveLength(0)
    expect(channelCalls('ai.text.abort')).toHaveLength(0)
  })

  it('执行独立于组件：从 config_status 一路走到 parse 并提交 submitted 状态', async () => {
    const draft = baseDraft()
    await startIndustrialVideoPreparation('reach-parse', { draft }, 'system-prompt')
    // parse 调用参数与现有 Composer startProduction 一致。
    expect(channelCalls('industrial_video.parse')).toHaveLength(1)
    const parseArgs = channelCalls('industrial_video.parse')[0][1] as Record<string, unknown>
    expect(parseArgs).toMatchObject({
      sessionId: 'reach-parse',
      run: 'run-1',
      voice: 'zh-CN-YunjianNeural',
      aspectRatio: '16:9',
      style: 'marketing',
      targetDurationS: 30,
      resolution: '1080P',
      ttsEnabled: true,
      subtitleEnabled: true,
      backgroundMusicEnabled: true,
      withAudio: true,
      logo: { name: 'up-logo.png' }
    })
    // media 来自两个图片/视频附件的上传句柄。
    expect(parseArgs.media).toEqual([
      { name: 'up-附件.png', caption: '附件.png' },
      { name: 'up-素材.mp4', caption: '素材.mp4' }
    ])
    // 资料分析文本被并入 texts。
    expect((parseArgs.texts as any[])[0].text).toContain('{"analysis":"ok"}')
    // 草稿与准备状态均已持久化，且最终 stage 为 submitted。
    expect(cacheService.getPersist('industrial_video.session_draft.reach-parse')).toEqual(draft)
    expect(cacheService.getPersist('industrial_video.preparation.reach-parse')?.stage).toBe('submitted')
    expect(cacheService.getPersist('industrial_video.preparation.reach-parse')?.result).toBe('{"analysis":"ok"}')
  })

  it('草稿含 material，但上传/解析仅走 attachments 与 logo，不污染 parse media', async () => {
    const draft = baseDraft({
      materials: [
        { id: 'm1', name: '知识文档', knowledgeItemId: 'ki-1', status: 'ready' },
        { id: 'm2', name: '失败材料', status: 'failed', error: '解析失败' }
      ]
    })
    await startIndustrialVideoPreparation('with-materials', { draft }, 'system-prompt')
    const parseArgs = channelCalls('industrial_video.parse')[0][1] as Record<string, unknown>
    // media 仍只含两个本地附件，知识库材料不进入上传 media。
    expect(parseArgs.media).toHaveLength(2)
    expect(cacheService.getPersist('industrial_video.preparation.with-materials')?.stage).toBe('submitted')
  })

  it('失败保留输入与错误信息，且 Promise 正常 resolve（不自动重试）', async () => {
    // 让资料分析返回空文本，触发分析失败分支。
    ipcMock.request.mockImplementation(async (channel: string) => {
      if (channel === 'industrial_video.config_status') return { configured: true }
      if (channel === 'ai.text.generate') return { text: '   ' }
      if (channel === 'industrial_video.run_create') return { run: 'run-1' }
      if (channel === 'industrial_video.parse') return {}
      return undefined
    })
    const draft = baseDraft()
    // 失败不应抛出，Promise 正常 resolve。
    await expect(startIndustrialVideoPreparation('fail-keep', { draft }, 'system-prompt')).resolves.toBeUndefined()
    const prep = cacheService.getPersist('industrial_video.preparation.fail-keep')
    expect(prep?.stage).toBe('failed')
    expect(prep?.error).toContain('资料分析未成功')
    // 输入（含 attachments/logo）被保留。
    expect(prep?.input).toEqual(draft)
    // 不自动重试：generate 仅调用一次，parse 未触及。
    expect(channelCalls('ai.text.generate')).toHaveLength(1)
    expect(channelCalls('industrial_video.parse')).toHaveLength(0)
  })

  it('保存状态早于 IPC：首个 IPC(config_status) 发起时 persist 已是 uploading', async () => {
    let capturedStage: string | undefined
    ipcMock.request.mockImplementation(async (channel: string) => {
      if (channel === 'industrial_video.config_status') {
        capturedStage = cacheService.getPersist('industrial_video.preparation.early-ipc')?.stage
        return { configured: true }
      }
      if (channel === 'ai.text.generate') return { text: '{"analysis":"ok"}' }
      if (channel === 'industrial_video.run_create') return { run: 'run-1' }
      if (channel === 'industrial_video.parse') return {}
      return undefined
    })
    await startIndustrialVideoPreparation('early-ipc', { draft: baseDraft() }, 'system-prompt')
    expect(capturedStage).toBe('uploading')
  })

  it('已有非 failed/非 submitted 的 persist 任务时拒绝新建，不覆盖原任务', async () => {
    // 模拟另一窗口正在运行的上传中任务。
    cacheService.setPersist('industrial_video.preparation.reject-active', {
      input: baseDraft(),
      stage: 'analyzing',
      result: '',
      error: '',
      startedAt: 1000,
      updatedAt: 1000
    })
    await expect(
      startIndustrialVideoPreparation('reject-active', { draft: baseDraft() }, 'system-prompt')
    ).rejects.toThrow(/已有进行中/)
    // 原任务未被覆盖成 failed 或 uploading。
    const prep = cacheService.getPersist('industrial_video.preparation.reject-active')
    expect(prep?.stage).toBe('analyzing')
    expect(channelCalls('ai.text.generate')).toHaveLength(0)
  })

  it('submitted 任务允许重做（新版本覆盖），不拒绝', async () => {
    cacheService.setPersist('industrial_video.preparation.redo-submitted', {
      input: baseDraft(),
      stage: 'submitted',
      result: 'old',
      error: '',
      startedAt: 1000,
      updatedAt: 1000
    })
    await startIndustrialVideoPreparation('redo-submitted', { draft: baseDraft() }, 'system-prompt')
    const prep = cacheService.getPersist('industrial_video.preparation.redo-submitted')
    expect(prep?.stage).toBe('submitted')
    expect(prep?.result).toBe('{"analysis":"ok"}')
    expect(prep?.startedAt).not.toBe(1000)
  })

  it('服务未配置时失败保存 error，仍正常 resolve', async () => {
    ipcMock.request.mockImplementation(async (channel: string) => {
      if (channel === 'industrial_video.config_status') return { configured: false }
      return undefined
    })
    await expect(
      startIndustrialVideoPreparation('unconfigured', { draft: baseDraft() }, 'system-prompt')
    ).resolves.toBeUndefined()
    const prep = cacheService.getPersist('industrial_video.preparation.unconfigured')
    expect(prep?.stage).toBe('failed')
    expect(prep?.error).toContain('尚未配置')
    expect(channelCalls('ai.text.generate')).toHaveLength(0)
  })
})
