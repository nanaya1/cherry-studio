import { describe, expect, it } from 'vitest'

import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

describe('industrial video IPC contract boundary', () => {
  it('rejects unknown generation settings instead of forwarding them to HTTP', () => {
    const route = industrialVideoRequestSchemas['industrial_video.video_start']
    expect(route.input.safeParse({ sessionId: 's1', run: 'r1' }).success).toBe(true)
    for (const extra of [
      { resolution: '4K' },
      { duration: 30 },
      { with_audio: false },
      { token: 'secret' },
      { stage: 'all' }
    ]) {
      expect(route.input.safeParse({ sessionId: 's1', run: 'r1', ...extra }).success).toBe(false)
    }
  })

  it('does not expose a generic operation proxy or server administration routes', () => {
    expect(Object.keys(industrialVideoRequestSchemas)).not.toContain('industrial_video.call')
    expect(Object.keys(industrialVideoRequestSchemas)).not.toContain('industrial_video.run_delete')
    expect(Object.keys(industrialVideoRequestSchemas)).not.toContain('industrial_video.config_get')
  })

  it('exposes download_artifact: requires session+run+path, never a renderer directory, optional non-negative expectedSize', () => {
    const route = industrialVideoRequestSchemas['industrial_video.download_artifact']
    expect(route).toBeDefined()
    // missing session → rejected
    expect(route.input.safeParse({ run: 'r1', path: 'final/m.mp4' }).success).toBe(false)
    // well-formed
    expect(route.input.safeParse({ sessionId: 's1', run: 'r1', path: 'final/m.mp4' }).success).toBe(true)
    // a renderer-supplied destination directory must NOT be accepted (strict schema)
    expect(
      route.input.safeParse({ sessionId: 's1', run: 'r1', path: 'final/m.mp4', workspaceDir: '/evil' }).success
    ).toBe(false)
    // expectedSize must be a non-negative integer when present
    expect(route.input.safeParse({ sessionId: 's1', run: 'r1', path: 'p', expectedSize: -1 }).success).toBe(false)
    expect(route.input.safeParse({ sessionId: 's1', run: 'r1', path: 'p', expectedSize: 4096 }).success).toBe(true)
    // output carries the published file path + size
    expect(route.output.safeParse({ filePath: '/ws/m.mp4', size: 4096 }).success).toBe(true)
  })

  it('审核IPC仅接收归属、类型及实际查看版本，拒绝凭据注入', () => {
    const snapshot = industrialVideoRequestSchemas['industrial_video.review_snapshot_get']
    const confirm = industrialVideoRequestSchemas['industrial_video.review_confirm']
    const input = { sessionId: 's1', run: 'r1', reviewType: 'sources' }
    expect(snapshot.input.parse(input)).toEqual(input)
    expect(snapshot.input.parse({ sessionId: 's1', run: 'r1' }).reviewType).toBe('script_and_storyboard')
    expect(confirm.input.safeParse(input).success).toBe(false)
    expect(confirm.input.parse({ ...input, expectedReviewVersion: ' v1 ' }).expectedReviewVersion).toBe(' v1 ')
    for (const extra of [
      { host_assertion: 'x' },
      { hostAssertion: 'x' },
      { secret: 'x' },
      { actor: 'x' },
      { token: 'x' }
    ]) {
      expect(snapshot.input.safeParse({ ...input, ...extra }).success).toBe(false)
      expect(confirm.input.safeParse({ ...input, expectedReviewVersion: 'v1', ...extra }).success).toBe(false)
    }
    expect(confirm.input.safeParse({ ...input, expectedReviewVersion: ' ' }).success).toBe(false)
    expect(snapshot.input.safeParse({ ...input, reviewType: 'qa' }).success).toBe(false)
  })

  it('审核输出必要字段强校验、保留 snake_case 扩展字段及未知阻塞项', () => {
    const snapshot = industrialVideoRequestSchemas['industrial_video.review_snapshot_get'].output
    const confirm = industrialVideoRequestSchemas['industrial_video.review_confirm'].output
    const receipt = {
      review_version: 'v1',
      generation_allowed: false,
      remaining_blockers: [null, { code: 'qa' }],
      future_field: 1
    }
    expect(confirm.parse(receipt)).toEqual(receipt)
    expect(snapshot.safeParse(receipt).success).toBe(false)
    const documents = { ...receipt, script: '', storyboard: { future_field: true } }
    expect(snapshot.parse(documents)).toEqual(documents)
    expect(snapshot.safeParse({ ...documents, storyboard: [] }).success).toBe(false)
    expect(snapshot.safeParse({ ...receipt, review_type: 'sources', sources: [], source_text: '' }).success).toBe(true)
    for (const patch of [{ review_version: '' }, { generation_allowed: 'false' }, { remaining_blockers: {} }]) {
      expect(confirm.safeParse({ ...receipt, ...patch }).success).toBe(false)
    }
  })

  it('requires a session on all data-bearing operations', () => {
    for (const [name, route] of Object.entries(industrialVideoRequestSchemas)) {
      if (name === 'industrial_video.config_status') continue
      expect(route.input.safeParse({ run: 'r1', jobId: 'j1' }).success).toBe(false)
    }
  })
})
