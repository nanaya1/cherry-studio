import { describe, expect, it } from 'vitest'

import { uint8ArraySchema } from '@shared/ipc/schemas/common'
import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

/**
 * Contract tests for the confirmed industrial-video HTTP contract (COWORK_HTTP_GUIDE §17).
 * These assert the renderer→main IPC allowlist shape exactly as the document specifies,
 * so they go RED before the implementation lands and stay GREEN afterwards.
 */

const SIX_VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunxiaNeural'
] as const

function parseOk(route: string, input: unknown): boolean {
  return industrialVideoRequestSchemas[route as keyof typeof industrialVideoRequestSchemas].input.safeParse(input)
    .success
}

describe('industrial_video IPC contract: six fixed voices', () => {
  for (const route of ['industrial_video.video_start', 'industrial_video.estimate', 'industrial_video.parse']) {
    it(`${route} accepts all six fixed voices and rejects unknown ones`, () => {
      for (const voice of SIX_VOICES) {
        expect(parseOk(route, { sessionId: 's', run: 'r', voice })).toBe(true)
      }
      // An unknown / non-enum voice must be rejected (server returns 422).
      expect(parseOk(route, { sessionId: 's', run: 'r', voice: 'zh-CN-UnknownNeural' })).toBe(false)
    })
  }
})

describe('industrial_video IPC contract: planning / audio settings fields', () => {
  const settings = {
    targetDurationS: 60,
    resolution: '1080P',
    ttsEnabled: true,
    subtitleEnabled: false,
    backgroundMusicEnabled: true,
    withAudio: false,
    expectedSettingsVersion: 3
  }

  for (const route of ['industrial_video.video_start', 'industrial_video.estimate', 'industrial_video.parse']) {
    it(`${route} accepts the new camelCase settings fields`, () => {
      expect(parseOk(route, { sessionId: 's', run: 'r', ...settings })).toBe(true)
    })

    it(`${route} rejects out-of-range targetDurationS (1–600) and bad resolution`, () => {
      expect(parseOk(route, { sessionId: 's', run: 'r', targetDurationS: 0 })).toBe(false)
      expect(parseOk(route, { sessionId: 's', run: 'r', targetDurationS: 601 })).toBe(false)
      expect(parseOk(route, { sessionId: 's', run: 'r', resolution: '4K' })).toBe(false)
    })

    it(`${route} rejects unknown extra fields (strict allowlist)`, () => {
      expect(parseOk(route, { sessionId: 's', run: 'r', background_music_track_id: 'x' })).toBe(false)
    })
  }
})

describe('industrial_video.upload IPC contract (raw bytes)', () => {
  it('exposes an `industrial_video.upload` route', () => {
    expect(industrialVideoRequestSchemas['industrial_video.upload']).toBeDefined()
  })

  it('accepts { sessionId, name, content: Uint8Array } and validates the binary payload', () => {
    const route = industrialVideoRequestSchemas['industrial_video.upload']
    expect(
      route.input.safeParse({ sessionId: 's', name: 'front.png', content: new Uint8Array([1, 2, 3]) }).success
    ).toBe(true)
    // missing content → rejected
    expect(route.input.safeParse({ sessionId: 's', name: 'front.png' }).success).toBe(false)
    // non-Uint8Array content → rejected
    expect(route.input.safeParse({ sessionId: 's', name: 'front.png', content: 'base64string' }).success).toBe(false)
    // empty name → rejected
    expect(route.input.safeParse({ sessionId: 's', name: '  ', content: new Uint8Array([1]) }).success).toBe(false)
  })

  it('uint8ArraySchema accepts a Uint8Array and rejects other shapes', () => {
    expect(uint8ArraySchema.safeParse(new Uint8Array([1])).success).toBe(true)
    expect(uint8ArraySchema.safeParse(Buffer.from([1])).success).toBe(true)
    expect(uint8ArraySchema.safeParse('x').success).toBe(false)
  })

  it('output is exactly { name } (no token / path leaked to the renderer)', () => {
    const route = industrialVideoRequestSchemas['industrial_video.upload']
    expect(route.output.safeParse({ name: 'front.png' }).success).toBe(true)
    expect(route.output.parse({ name: 'front.png', token: 'secret', size: 4 })).toEqual({ name: 'front.png' })
  })
})
