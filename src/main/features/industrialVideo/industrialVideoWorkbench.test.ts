import { describe, expect, it, vi } from 'vitest'

import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

import { IndustrialVideoClient } from './IndustrialVideoClient'
import type { IndustrialVideoResult, VideoApiRecord } from './IndustrialVideoClient'

function ok<T>(data: T, requestId = 'req-ok'): IndustrialVideoResult<T> {
  return { ok: true, requestId, data }
}

describe('工业 IPC 契约：workbench_open / workbench_get', () => {
  it('workbench_open 输入 sessionId 必填、run/embed 可选，输出含 workbench_url', () => {
    const route = industrialVideoRequestSchemas['industrial_video.workbench_open']
    expect(() => route.input.parse({ sessionId: 's1' })).not.toThrow()
    expect(() => route.input.parse({ sessionId: 's1', run: 'r1', embed: true })).not.toThrow()
    expect(() => route.input.parse({})).toThrow()
    expect(() => route.input.parse({ sessionId: 's1', extra: 1 })).toThrow()
    expect(() => route.output.parse({ workbench_url: 'https://wb/r1', run: 'r1' })).not.toThrow()
    expect(() => route.output.parse({ workbench_url: 'u' })).toThrow()
  })

  it('workbench_get 输入需 sessionId + run，输出含真实状态字段', () => {
    const route = industrialVideoRequestSchemas['industrial_video.workbench_get']
    expect(() => route.input.parse({ sessionId: 's1', run: 'r1' })).not.toThrow()
    expect(() => route.input.parse({ sessionId: 's1' })).toThrow()
    expect(() =>
      route.output.parse({
        run: 'r1',
        generation_status: 'ready',
        needs_script_sync: false,
        document_needs_sync: false,
        approved: false,
        approved_verified: false,
        generatable: false,
        blockers: ['awaiting_script_review'],
        raw: {}
      })
    ).not.toThrow()
    // 缺 generation_status / generatable 等必填字段应报错。
    expect(() => route.output.parse({ run: 'r1', approved: true })).toThrow()
  })
})

describe('IndustrialVideoClient workbench 归一', () => {
  function client(): IndustrialVideoClient {
    return new IndustrialVideoClient({ baseUrl: 'http://x', token: 't', timeoutMs: 1 })
  }

  it('workbenchOpen 兼容 workbench_url / url / workbenchUrl 任一字段', async () => {
    for (const field of ['workbench_url', 'url', 'workbenchUrl']) {
      const c = client()
      const spy = vi.spyOn(c as unknown as { call: typeof c['call'] }, 'call').mockResolvedValue(
        ok({ [field]: `https://wb/r1?f=${field}`, run: 'r1' })
      )
      const res = await c.workbenchOpen({ run: 'r1', embed: true })
      expect(res.ok).toBe(true)
      expect(res.ok && res.data.workbenchUrl).toBe(`https://wb/r1?f=${field}`)
      spy.mockRestore()
    }
  })

  it('workbenchOpen 缺链接字段时报校验错误', async () => {
    const c = client()
    vi.spyOn(c as unknown as { call: typeof c['call'] }, 'call').mockResolvedValue(ok({ run: 'r1' }))
    const res = await c.workbenchOpen({ run: 'r1' })
    expect(res.ok).toBe(false)
  })

  it('workbenchGet 透传原始 BusinessObject', async () => {
    const c = client()
    const raw: VideoApiRecord = { generation_allowed: true, remaining_blockers: [] }
    vi.spyOn(c as unknown as { call: typeof c['call'] }, 'call').mockResolvedValue(ok(raw))
    const res = await c.workbenchGet({ run: 'r1' })
    expect(res.ok && res.data).toEqual(raw)
  })
})
