import { describe, expect, it } from 'vitest'

import type { IndustrialVideoProductionRecord, IndustrialVideoRound } from '@shared/data/cache/cacheValueTypes'

import { canResubmitAfterStoryboardError, projectStoryboardSubmission } from './industrialVideoStoryboardSubmission'

describe('projectStoryboardSubmission', () => {
  it('过滤服务端只读元数据，保留 schema 内合法字段', () => {
    const input = {
      video_title: '产品视频',
      video_subtitle: '副标题',
      worker_look: '工厂实拍',
      end_notes: '片尾字幕',
      style: 'marketing', // 服务端只读元数据
      plan_version: 'v3', // 服务端只读元数据
      source_validation: { ok: true }, // 服务端只读元数据
      custom: { retain: true }, // 任意自定义字段不得在白名单之外透传
      scenes: [
        {
          id: 1,
          title: '开场',
          duration: 5,
          prompt: '真实画面',
          scene_uid: 'scene-uuid-1', // schema 内合法字段
          media_refs: ['media-a'], // schema 内合法字段
          narration: [{ start: 0, end: 5, text: '旁白', voice: 'original' }]
        },
        {
          id: 2,
          title: '转场',
          duration: 8,
          prompt: '设备细节',
          scene_uid: 'scene-uuid-2',
          media_refs: ['media-b', 'media-c']
        }
      ]
    }
    const out = projectStoryboardSubmission(input) as {
      video_title: string
      video_subtitle: string
      worker_look: string
      end_notes: string
      scenes: Array<Record<string, unknown>>
    }
    expect(out.video_title).toBe('产品视频')
    expect(out.video_subtitle).toBe('副标题')
    expect(out.worker_look).toBe('工厂实拍')
    expect(out.end_notes).toBe('片尾字幕')
    // 服务端只读元数据必须被过滤
    expect(out).not.toHaveProperty('style')
    expect(out).not.toHaveProperty('plan_version')
    expect(out).not.toHaveProperty('source_validation')
    // 任意自定义字段不得透传
    expect(out).not.toHaveProperty('custom')
    // schema 内合法字段保留
    expect(out.scenes[0].scene_uid).toBe('scene-uuid-1')
    expect(out.scenes[0].media_refs).toEqual(['media-a'])
    expect(out.scenes[1].scene_uid).toBe('scene-uuid-2')
    expect(out.scenes[1].media_refs).toEqual(['media-b', 'media-c'])
    // 场景与嵌套旁白保留（narration 仅保留 text/start/end 白名单）
    expect(out.scenes[0].id).toBe(1)
    expect(out.scenes[0].prompt).toBe('真实画面')
    const narration = out.scenes[0].narration as Array<Record<string, unknown>>
    expect(narration[0].text).toBe('旁白')
    expect(narration[0]).not.toHaveProperty('voice')
  })

  it('无返回元数据时投影不改变结构，不丢本地编辑内容', () => {
    const input = { video_title: 't', scenes: [{ id: 1, duration: 5, prompt: 'p' }] }
    expect(projectStoryboardSubmission(input)).toEqual(input)
  })

  it('保留字符串旁白（兼容既有 schema 通过的非数组旁白）', () => {
    const input = { video_title: 't', scenes: [{ id: 1, duration: 5, prompt: 'p', narration: '原旁白' }] }
    const out = projectStoryboardSubmission(input) as { scenes: Array<{ narration: unknown }> }
    expect(out.scenes[0].narration).toBe('原旁白')
  })
})

describe('canResubmitAfterStoryboardError', () => {
  const run = 'run-1'
  const round = (overrides: Partial<IndustrialVideoRound> = {}): IndustrialVideoRound => ({
    version: 1,
    operation: 'storyboard_submit',
    run,
    jobId: null,
    state: 'failed',
    requestId: 'req-1',
    at: 0,
    outcome: 'error',
    ...overrides
  })
  const recordOf = (
    rounds: IndustrialVideoRound[],
    extra: Partial<IndustrialVideoProductionRecord> = {}
  ): IndustrialVideoProductionRecord => ({
    sessionId: 's',
    version: 1,
    run,
    jobId: null,
    state: 'failed',
    rounds,
    unknownSubmissions: [],
    updatedAt: 0,
    ...extra
  })

  it('本 run 的 storyboard_submit error 且 record.jobId 与末轮 jobId 均为 null 时允许', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round()]), { status: 'blocked' })).toBe(true)
  })

  it('末轮 jobId 非空时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round({ jobId: 'j' })]))).toBe(false)
  })

  it('record.jobId 非空时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round()], { jobId: 'j' }))).toBe(false)
  })

  it('存在 unknown 提交时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round()], { unknownSubmissions: [round()] }))).toBe(false)
  })

  it('最后 round 不是 storyboard_submit 时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round({ operation: 'review_confirm', outcome: 'ok' })]))).toBe(
      false
    )
  })

  it('本 run 之外时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round({ run: 'other' })]))).toBe(false)
  })

  it('任务进行中（queued/running）禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round()]), { status: 'running' })).toBe(false)
    expect(canResubmitAfterStoryboardError(recordOf([round()]), { status: 'queued' })).toBe(false)
  })

  it('非 failed 状态禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([round()], { state: 'blocked' }))).toBe(false)
    expect(canResubmitAfterStoryboardError(recordOf([round()], { state: 'storyboard_submitted' }))).toBe(false)
  })

  it('无 rounds 或 record 为空时禁止', () => {
    expect(canResubmitAfterStoryboardError(recordOf([]))).toBe(false)
    expect(canResubmitAfterStoryboardError(null)).toBe(false)
    expect(canResubmitAfterStoryboardError(undefined)).toBe(false)
  })
})
