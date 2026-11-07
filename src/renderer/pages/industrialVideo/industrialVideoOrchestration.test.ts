import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { beforeEach, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import { ipcApi } from '@renderer/ipc'

import {
  advanceIndustrialVideoOrchestration,
  appendIndustrialVideoRevision,
  readIndustrialVideoRevisions,
  retryIndustrialVideoOrchestration
} from './industrialVideoOrchestration'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
const request = vi.mocked(ipcApi.request)
const board = {
  video_title: '设备',
  scenes: [{ id: 1, title: '整体', duration: 5, prompt: '设备整体', narration: [] }]
}
beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
  cacheService.setPersist('industrial_video.session_draft.s1', {
    orchestration: 'dedicated',
    requirement: '展示设备',
    modelId: 'test::model',
    settings: createIndustrialVideoSettings('marketing')
  })
  request.mockImplementation(async (channel) => {
    if (channel === 'industrial_video.get_records')
      return { run: 'run1', jobId: 'job1', state: 'planning', unknownSubmissions: [] } as never
    if (channel === 'industrial_video.job_get') return { run: 'run1', status: 'done', stage: 'parse' } as never
    if (channel === 'industrial_video.planning_context_get')
      return { sources_ready: true, input_fingerprint: 'fp1', expected_storyboard_sha256: 'sha1' } as never
    if (channel === 'ai.text.generate') return { text: JSON.stringify(board) } as never
    if (channel === 'industrial_video.storyboard_submit') return { submitted: true, reviewRequired: true } as never
    throw new Error(`Unexpected ${channel}`)
  })
})
it('submits a validated draft with server fingerprints once, never approves or starts paid generation', async () => {
  await Promise.all([advanceIndustrialVideoOrchestration('s1'), advanceIndustrialVideoOrchestration('s1')])
  await advanceIndustrialVideoOrchestration('s1')
  expect(request).toHaveBeenCalledWith('industrial_video.storyboard_submit', {
    sessionId: 's1',
    run: 'run1',
    storyboard: board,
    expectedInputFingerprint: 'fp1',
    expectedStoryboardSha256: 'sha1'
  })
  expect(request.mock.calls.filter(([channel]) => channel === 'industrial_video.storyboard_submit')).toHaveLength(1)
  expect(
    request.mock.calls.some(([channel]) =>
      ['industrial_video.review_confirm', 'industrial_video.video_start'].includes(channel)
    )
  ).toBe(false)
  expect(cacheService.getPersist('industrial_video.preparation.s1')?.stage).toBe('planned')
})
it('does not resubmit after a model failure', async () => {
  request.mockImplementation(async (channel) => {
    if (channel === 'industrial_video.get_records')
      return { run: 'run1', jobId: 'job1', state: 'planning', unknownSubmissions: [] } as never
    if (channel === 'industrial_video.job_get') return { run: 'run1', status: 'done' } as never
    if (channel === 'industrial_video.planning_context_get')
      return { sources_ready: true, input_fingerprint: 'fp1', expected_storyboard_sha256: 'sha1' } as never
    throw new Error('Model unavailable')
  })
  await advanceIndustrialVideoOrchestration('s1')
  await advanceIndustrialVideoOrchestration('s1')
  expect(cacheService.getPersist('industrial_video.preparation.s1')?.stage).toBe('failed')
  expect(request.mock.calls.filter(([channel]) => channel === 'ai.text.generate')).toHaveLength(1)
})
it('plans after a completed parse but never replans a completed video', async () => {
  request.mockImplementation(async (channel) => {
    if (channel === 'industrial_video.get_records')
      return {
        run: 'run1',
        jobId: 'job1',
        state: 'done',
        rounds: [{ operation: 'video_start', outcome: 'ok' }],
        unknownSubmissions: []
      } as never
    throw new Error(`Unexpected ${channel}`)
  })
  await advanceIndustrialVideoOrchestration('s1')
  expect(request.mock.calls.some(([channel]) => channel === 'ai.text.generate')).toBe(false)
})
it.each(['planning', 'storyboard_submitted', 'done'])(
  '修改在安全状态 %s 真正进入专用规划且仅消费一次',
  async (state) => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (channel, input) => {
      if (channel === 'industrial_video.get_records')
        return {
          run: 'run1',
          jobId: 'job1',
          state,
          rounds: [{ operation: 'video_start', outcome: 'ok' }],
          unknownSubmissions: []
        } as never
      if (channel === 'industrial_video.job_get') return { run: 'run1', status: 'done', stage: 'video' } as never
      return original(channel, input)
    })
    const revision = appendIndustrialVideoRevision('s1', '突出节能，缩短片头')!
    await advanceIndustrialVideoOrchestration('s1')
    await advanceIndustrialVideoOrchestration('s1')
    await retryIndustrialVideoOrchestration('s1')
    const generation = request.mock.calls.find(([channel]) => channel === 'ai.text.generate')!
    expect(generation).toBeDefined()
    expect(JSON.stringify(generation[1])).toContain('展示设备')
    expect(JSON.stringify(generation[1])).toContain('突出节能，缩短片头')
    expect(request).toHaveBeenCalledWith('industrial_video.storyboard_submit', {
      sessionId: 's1',
      run: 'run1',
      storyboard: board,
      expectedInputFingerprint: 'fp1',
      expectedStoryboardSha256: 'sha1'
    })
    expect(request.mock.calls.filter(([channel]) => channel === 'industrial_video.storyboard_submit')).toHaveLength(1)
    expect(readIndustrialVideoRevisions('s1')).toEqual([
      expect.objectContaining({ id: revision.id, consumedRun: 'run1' })
    ])
    expect(
      request.mock.calls.every(([channel]) =>
        [
          'industrial_video.get_records',
          'industrial_video.job_get',
          'industrial_video.planning_context_get',
          'ai.text.generate',
          'industrial_video.storyboard_submit'
        ].includes(channel)
      )
    ).toBe(true)
  }
)
it.each(['parsing', 'generating', 'assembling', 'confirming', 'blocked'])(
  '状态 %s 暂存修改，不抢占制作',
  async (state) => {
    request.mockImplementation(async () => ({ run: 'run1', jobId: 'job1', state, unknownSubmissions: [] }) as never)
    const revision = appendIndustrialVideoRevision('s1', '改成简洁风格')!
    await advanceIndustrialVideoOrchestration('s1')
    expect(readIndustrialVideoRevisions('s1')).toEqual([revision])
    expect(request.mock.calls.every(([channel]) => channel === 'industrial_video.get_records')).toBe(true)
  }
)
it('解析期间暂存的修改在解析完成后消费', async () => {
  const original = request.getMockImplementation()!
  let parsing = true
  request.mockImplementation(async (channel, input) => {
    if (channel === 'industrial_video.get_records' && parsing)
      return { run: 'run1', jobId: 'job1', state: 'parsing', unknownSubmissions: [] } as never
    return original(channel, input)
  })
  appendIndustrialVideoRevision('s1', '突出设备特写')
  await advanceIndustrialVideoOrchestration('s1')
  expect(request.mock.calls.some(([channel]) => channel === 'ai.text.generate')).toBe(false)
  parsing = false
  await advanceIndustrialVideoOrchestration('s1')
  expect(JSON.stringify(request.mock.calls.find(([channel]) => channel === 'ai.text.generate')?.[1])).toContain(
    '突出设备特写'
  )
  expect(readIndustrialVideoRevisions('s1')[0]).toMatchObject({ consumedRun: 'run1' })
})
it('未知提交阻断修改和手动重试', async () => {
  request.mockImplementation(
    async () =>
      ({
        run: 'run1',
        jobId: 'job1',
        state: 'storyboard_submitted',
        unknownSubmissions: [{}]
      }) as never
  )
  const revision = appendIndustrialVideoRevision('s1', '修改结尾')!
  await advanceIndustrialVideoOrchestration('s1')
  await retryIndustrialVideoOrchestration('s1')
  expect(readIndustrialVideoRevisions('s1')).toEqual([revision])
  expect(request.mock.calls.every(([channel]) => channel === 'industrial_video.get_records')).toBe(true)
})
it('失败保留修改和可见错误，仅显式重试重新消费', async () => {
  const original = request.getMockImplementation()!
  let fail = true
  request.mockImplementation(async (channel, input) => {
    if (channel === 'ai.text.generate' && fail) throw new Error('模型暂不可用')
    return original(channel, input)
  })
  const revision = appendIndustrialVideoRevision('s1', '增加设备特写')!
  await advanceIndustrialVideoOrchestration('s1')
  expect(cacheService.getPersist('industrial_video.preparation.s1')).toMatchObject({
    stage: 'failed',
    error: '模型暂不可用'
  })
  expect(readIndustrialVideoRevisions('s1')).toEqual([revision])
  fail = false
  await advanceIndustrialVideoOrchestration('s1')
  expect(request.mock.calls.filter(([channel]) => channel === 'ai.text.generate')).toHaveLength(1)
  await retryIndustrialVideoOrchestration('s1')
  expect(readIndustrialVideoRevisions('s1')[0]).toMatchObject({ consumedRun: 'run1' })
  expect(cacheService.getPersist('industrial_video.preparation.s1')).toMatchObject({ stage: 'planned', error: '' })
})
it.each(['拒绝提交', '缺少指纹'])('%s 时不消费修改并保留失败原因', async (failure) => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (channel, input) => {
    if (channel === 'industrial_video.storyboard_submit' && failure === '拒绝提交') return { submitted: false } as never
    if (channel === 'industrial_video.planning_context_get' && failure === '缺少指纹')
      return { sources_ready: true } as never
    return original(channel, input)
  })
  const revision = appendIndustrialVideoRevision('s1', '重写片头')!
  await advanceIndustrialVideoOrchestration('s1')
  expect(readIndustrialVideoRevisions('s1')).toEqual([revision])
  expect(cacheService.getPersist('industrial_video.preparation.s1')).toMatchObject({
    stage: 'failed',
    error: expect.any(String)
  })
  expect(cacheService.getPersist('industrial_video.preparation.s1')?.error).not.toBe('')
})
it('首次规划进行中追加的修改不会丢失或被提前标记消费', async () => {
  const original = request.getMockImplementation()!
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const generating = new Promise<void>((resolve) => {
    entered = resolve
  })
  request.mockImplementation(async (channel, input) => {
    if (channel === 'ai.text.generate' && !request.mock.calls.slice(0, -1).some(([name]) => name === channel)) {
      entered()
      await waiting
    }
    return original(channel, input)
  })
  const pending = advanceIndustrialVideoOrchestration('s1')
  await generating
  appendIndustrialVideoRevision('s1', '新增结尾镜头')
  release()
  await pending
  await advanceIndustrialVideoOrchestration('s1')
  expect(request.mock.calls.filter(([channel]) => channel === 'industrial_video.storyboard_submit')).toHaveLength(2)
  expect(readIndustrialVideoRevisions('s1')[0]).toMatchObject({ consumedRun: 'run1' })
})
it('同一 run 已有规划后，新增修改仍能重规划并保留之前的修改要求', async () => {
  appendIndustrialVideoRevision('s1', '片头改成设备特写')
  await advanceIndustrialVideoOrchestration('s1')
  appendIndustrialVideoRevision('s1', '片尾加入维护说明')
  await advanceIndustrialVideoOrchestration('s1')
  const generation = request.mock.calls.filter(([channel]) => channel === 'ai.text.generate').at(-1)
  expect(JSON.stringify(generation?.[1])).toContain('片头改成设备特写')
  expect(JSON.stringify(generation?.[1])).toContain('片尾加入维护说明')
  expect(request.mock.calls.filter(([channel]) => channel === 'industrial_video.storyboard_submit')).toHaveLength(2)
})
it('显式本地脚本文本进入规划，不读取任何文件路径', async () => {
  appendIndustrialVideoRevision('s1', '保留草稿结构')
  await advanceIndustrialVideoOrchestration('s1')
  // 显式文本通过下一条修改传入，不从工作区或结果缓存猜测。
  appendIndustrialVideoRevision('s1', '采用本地脚本', '本地脚本：先展示产线，再展示设备')
  await advanceIndustrialVideoOrchestration('s1')
  const generations = request.mock.calls.filter(([channel]) => channel === 'ai.text.generate')
  expect(JSON.stringify(generations.at(-1)?.[1])).toContain('本地脚本：先展示产线，再展示设备')
  expect(request.mock.calls.some(([channel]) => channel.startsWith('file.'))).toBe(false)
})
it('生成期间暂存，完成后使用最新指纹重规划并可在审核状态重试', async () => {
  const original = request.getMockImplementation()!
  let state = 'generating'
  let fail = true
  request.mockImplementation(async (channel, input) => {
    if (channel === 'industrial_video.get_records')
      return { run: 'run1', jobId: 'job1', state, rounds: [], unknownSubmissions: [] } as never
    if (channel === 'industrial_video.job_get') return { run: 'run1', status: 'done', stage: 'video' } as never
    if (channel === 'industrial_video.planning_context_get')
      return { sources_ready: true, input_fingerprint: 'fp-new', expected_storyboard_sha256: 'sha-new' } as never
    if (channel === 'ai.text.generate' && fail) throw new Error('模型重规划失败')
    return original(channel, input)
  })
  appendIndustrialVideoRevision('s1', '缩短片尾')
  await advanceIndustrialVideoOrchestration('s1')
  expect(request.mock.calls.some(([channel]) => channel === 'ai.text.generate')).toBe(false)
  state = 'storyboard_submitted'
  await advanceIndustrialVideoOrchestration('s1')
  expect(readIndustrialVideoRevisions('s1')[0].consumedRun).toBeUndefined()
  expect(cacheService.getPersist('industrial_video.preparation.s1')?.error).toBe('模型重规划失败')
  fail = false
  await retryIndustrialVideoOrchestration('s1')
  expect(request).toHaveBeenCalledWith('industrial_video.storyboard_submit', {
    sessionId: 's1',
    run: 'run1',
    storyboard: board,
    expectedInputFingerprint: 'fp-new',
    expectedStoryboardSha256: 'sha-new'
  })
  expect(readIndustrialVideoRevisions('s1')[0].consumedRun).toBe('run1')
})
it('never takes over a legacy task', async () => {
  const draft = cacheService.getPersist('industrial_video.session_draft.s1')!
  cacheService.setPersist('industrial_video.session_draft.s1', { ...draft, orchestration: 'agent' })
  await advanceIndustrialVideoOrchestration('s1')
  expect(request).not.toHaveBeenCalled()
})
