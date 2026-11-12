import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IndustrialVideoClient, type IndustrialVideoClientConfig } from './IndustrialVideoClient'

const BASE_URL = 'http://127.0.0.1:8848'
const TOKEN = 'service-secret-token'
const TIMEOUT_MS = 10_000

function makeConfig(overrides: Partial<IndustrialVideoClientConfig> = {}): IndustrialVideoClientConfig {
  return { baseUrl: BASE_URL, token: TOKEN, timeoutMs: TIMEOUT_MS, ...overrides }
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers })
}

const fetchMock = vi.mocked(net.fetch)

describe('IndustrialVideoClient', () => {
  let client: IndustrialVideoClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockMainLoggerService.warn.mockClear()
    mockMainLoggerService.error.mockClear()
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    client = new IndustrialVideoClient(makeConfig())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts to /api/video/<operation> with Bearer auth, JSON content type and manual redirect', async () => {
    await client.planningContextGet({ run: 'demo-run' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/api/video/planning_context_get`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('content-type')).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify({ run: 'demo-run' }))
  })

  describe('审核 HTTP 契约', () => {
    const params = { run: 'r1', host_assertion: 'trusted-assertion', review_type: 'script_and_storyboard' as const }
    const snapshot = {
      review_version: 'v1',
      script: '# 脚本',
      storyboard: { scenes: [] },
      generation_allowed: false,
      remaining_blockers: [{ code: 'approval_required' }],
      script_sha256: 'sha'
    }

    it('原样提交审核参数并保留 snake_case 快照及未知字段', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(snapshot))
      expect(await client.reviewSnapshotGet(params)).toMatchObject({ ok: true, data: snapshot })
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/video/review_snapshot_get`)
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual(params)
    })

    it.each([
      { review_version: undefined },
      { review_version: '' },
      { review_version: 1 },
      { script: undefined },
      { script: {} },
      { storyboard: undefined },
      { storyboard: [] },
      { generation_allowed: undefined },
      { generation_allowed: 'true' },
      { remaining_blockers: undefined },
      { remaining_blockers: {} }
    ])('拒绝缺失或错误类型的必要快照字段 %j', async (patch) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, ...patch }))
      expect(await client.reviewSnapshotGet(params)).toMatchObject({ ok: false, error: { category: 'validation' } })
    })

    it('来源快照不要求尚未生成的双文档', async () => {
      const sources = {
        review_version: 'sources-v1',
        sources: [],
        source_text: '',
        generation_allowed: false,
        remaining_blockers: [null, 'documents']
      }
      fetchMock.mockResolvedValueOnce(jsonResponse(sources))
      expect(await client.reviewSnapshotGet({ ...params, review_type: 'sources' })).toMatchObject({
        ok: true,
        data: sources
      })
    })

    it('确认仅要求版本和门禁回执，不要求重复返回双文档', async () => {
      const receipt = { review_version: 'v1', generation_allowed: true, remaining_blockers: [], approved: true }
      fetchMock.mockResolvedValueOnce(jsonResponse(receipt))
      expect(await client.reviewConfirm({ ...params, expected_review_version: 'v1' })).toMatchObject({
        ok: true,
        data: receipt
      })
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/video/review_confirm`)
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        ...params,
        expected_review_version: 'v1'
      })
    })

    it.each([{ review_version: '' }, { generation_allowed: 'yes' }, { remaining_blockers: null }])(
      '拒绝无效确认回执 %j',
      async (patch) => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({ review_version: 'v1', generation_allowed: true, remaining_blockers: [], ...patch })
        )
        expect(await client.reviewConfirm({ ...params, expected_review_version: 'v1' })).toMatchObject({
          ok: false,
          error: { category: 'validation' }
        })
      }
    )

    it('409版本冲突保留错误码且绝不重试', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'review_version_conflict' }, 409))
      expect(await client.reviewConfirm({ ...params, expected_review_version: 'old' })).toMatchObject({
        ok: false,
        error: { status: 409, code: 'review_version_conflict', outcomeUnknown: false }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('strips a trailing slash from baseUrl', async () => {
    client = new IndustrialVideoClient(makeConfig({ baseUrl: `${BASE_URL}/` }))
    await client.capabilitiesGet()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/video/capabilities_get`)
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{}')
  })

  it('sends the operation whitelist name and body verbatim for each typed method', async () => {
    const cases: Array<[keyof IndustrialVideoClient, unknown[], string, Record<string, unknown>]> = [
      ['runCreate', [{ base_name: 'demo', prefix: 'agent' }], 'run_create', { base_name: 'demo', prefix: 'agent' }],
      [
        'videoStart',
        [{ run: 'demo-run', stage: 'video', estimate_only: true, voice: 'zh-female', with_audio: false }],
        'video_start',
        { run: 'demo-run', stage: 'video', estimate_only: true, voice: 'zh-female', with_audio: false }
      ],
      [
        'jobGet',
        [{ job_id: 'j1', wait_s: 10, tail_lines: 20 }],
        'job_get',
        { job_id: 'j1', wait_s: 10, tail_lines: 20 }
      ],
      ['jobList', [{ limit: 5 }], 'job_list', { limit: 5 }],
      ['jobCancel', [{ job_id: 'j1' }], 'job_cancel', { job_id: 'j1' }],
      ['sceneRetry', [{ run: 'demo-run', scene_id: 2 }], 'scene_retry', { run: 'demo-run', scene_id: 2 }],
      ['qaGet', [{ run: 'demo-run' }], 'qa_get', { run: 'demo-run' }],
      ['previewCreate', [{ run: 'demo-run', force: true }], 'preview_create', { run: 'demo-run', force: true }],
      [
        'artifactRead',
        [{ run: 'demo-run', path: 'status.json', max_chars: 100 }],
        'artifact_read',
        {
          run: 'demo-run',
          path: 'status.json',
          max_chars: 100
        }
      ],
      [
        'mediaUpload',
        [{ caption: 'cap', url: 'https://x/m.png', kind: 'image' }],
        'media_upload',
        {
          caption: 'cap',
          url: 'https://x/m.png',
          kind: 'image'
        }
      ],
      [
        'logoUpload',
        [{ url: 'https://x/l.png', brand_kind: 'product' }],
        'logo_upload',
        {
          url: 'https://x/l.png',
          brand_kind: 'product'
        }
      ],
      [
        'storyboardSubmit',
        [
          {
            run: 'demo-run',
            expected_input_fingerprint: 'fp',
            expected_storyboard_sha256: '',
            storyboard: { video_title: 't', scenes: [] }
          }
        ],
        'storyboard_submit',
        {
          run: 'demo-run',
          expected_input_fingerprint: 'fp',
          expected_storyboard_sha256: '',
          storyboard: { video_title: 't', scenes: [] }
        }
      ],
      ['storyboardGet', [{ run: 'demo-run', full: false }], 'storyboard_get', { run: 'demo-run', full: false }]
    ]

    for (const [method, args, operation, expectedBody] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
      // @ts-expect-error variadic call across the typed surface
      await client[method](...args)
      const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(url).toBe(`${BASE_URL}/api/video/${operation}`)
      expect(init?.body).toBe(JSON.stringify(expectedBody))
    }
  })

  it('passes voice and with_audio through verbatim (no dubbing-switch rewriting)', async () => {
    await client.videoStart({
      run: 'demo-run',
      stage: 'video',
      voice: 'caller-mapped-voice',
      with_audio: true
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.voice).toBe('caller-mapped-voice')
    expect(body.with_audio).toBe(true)
  })

  it('returns run_create run from the response record', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run: 'demo-2026' }))
    const result = await client.runCreate({ base_name: 'demo' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.run).toBe('demo-2026')
  })

  it('returns video_start job_id from the response record', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: 'job-9', status: 'queued', run: 'demo-run' }))
    const result = await client.videoStart({ run: 'demo-run', stage: 'video' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.job_id).toBe('job-9')
  })

  it('returns storyboard_submit submitted/review_required flags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ submitted: true, review_required: false, version: 2 }))
    const result = await client.storyboardSubmit({
      run: 'demo-run',
      expected_input_fingerprint: 'fp',
      expected_storyboard_sha256: '',
      storyboard: { video_title: 't', scenes: [] }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.submitted).toBe(true)
      expect(result.data.review_required).toBe(false)
    }
  })

  it('returns media_upload/logo_upload name handle', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'motor.png' }))
    const media = await client.mediaUpload({ caption: 'cap', url: 'https://x/m.png' })
    expect(media.ok && media.data.name).toBe('motor.png')

    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'brand.png' }))
    const logo = await client.logoUpload({ url: 'https://x/l.png' })
    expect(logo.ok && logo.data.name).toBe('brand.png')
  })

  it('returns artifact_read type and content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'text', content: '{"execution_id":"job-9"}' }))
    const result = await client.artifactRead({ run: 'demo-run', path: 'status.json' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.type).toBe('text')
      expect(result.data.content).toBe('{"execution_id":"job-9"}')
    }
  })

  it.each([
    [400, 'operation_rejected', '资料冲突', 'operation_rejected'],
    [401, 'unauthorized', 'bad token', 'unauthorized'],
    [422, 'invalid_arguments', 'bad args', 'invalid_arguments'],
    [500, 'internal_error', 'boom', 'internal_error']
  ])('maps HTTP %s to an http error with the server code', async (status, code, message, expectedCode) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: code, message, hint: 'h' }, status))
    const result = await client.jobGet({ job_id: 'j1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe('http')
      expect(result.error.code).toBe(expectedCode)
      expect(result.error.message).toBe(message)
      expect(result.error.status).toBe(status)
      expect(result.error.outcomeUnknown).toBe(false)
      expect(typeof result.requestId).toBe('string')
      expect(result.requestId.length).toBeGreaterThan(0)
    }
  })

  it('falls back to hint then error when message is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ hint: 'use hint', error: 'operation_rejected' }, 400))
    const result = await client.jobGet({ job_id: 'j1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('use hint')
  })

  it('treats a non-2xx response as an error even when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 400 }))
    const result = await client.jobGet({ job_id: 'j1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.category).toBe('http')
  })

  it('treats a 2xx non-object body as a validation error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[1,2,3]', { status: 200 }))
    const result = await client.runCreate({ base_name: 'demo' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.category).toBe('validation')
  })

  it('returns a validation error when run_create omits run', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }))
    const result = await client.runCreate({ base_name: 'demo' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.category).toBe('validation')
  })

  it('returns a validation error when video_start omits job_id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'queued' }))
    const result = await client.videoStart({ run: 'demo-run', stage: 'video' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.category).toBe('validation')
  })

  it('returns a network error (outcome unknown) and never retries on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const result = await client.qaGet({ run: 'demo-run' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe('network')
      expect(result.error.outcomeUnknown).toBe(true)
    }
  })

  it('returns a timeout error (outcome unknown) when the request aborts before the response', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    const promise = client.qaGet({ run: 'demo-run' })
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe('timeout')
      expect(result.error.outcomeUnknown).toBe(true)
    }
    expect(signal?.aborted).toBe(true)
  })

  it('treats a timeout during body read as outcome-unknown (no partial success)', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url, init) => {
      const signal = init?.signal ?? undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true })
        }
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })

    const promise = client.runCreate({ base_name: 'demo' })
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
    const result = await promise

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe('timeout')
      expect(result.error.outcomeUnknown).toBe(true)
    }
  })

  it.each([301, 307, 308])('does not follow a %s redirect and does not re-send the token', async (status) => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { status, headers: { Location: 'https://attacker.example/steal' } })
    )
    const result = await client.videoStart({ run: 'demo-run', stage: 'video' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/video/video_start`)
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe('http')
      expect(result.error.status).toBe(status)
    }
  })

  describe('upload (raw bytes to the root /upload route)', () => {
    const BYTES = new Uint8Array([1, 2, 3, 4])

    it('POSTs raw bytes to /upload?name=<name> with Bearer and octet-stream, returns { name }', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, name: 'front.png', size: 4, sha256: 'deadbeef' }))

      const result = await client.upload({ name: 'front.png', content: BYTES })

      expect(result.ok).toBe(true)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${BASE_URL}/upload?name=front.png`)
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect(headers.get('content-type')).toBe('application/octet-stream')
      // The body is the raw bytes, NOT a JSON string and NOT under /api/video/.
      expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(BYTES)
      expect(init?.body).not.toBe(JSON.stringify(BYTES))
      if (result.ok) expect(result.data).toEqual({ name: 'front.png' })
    })

    it.each([
      ['网络配置重置｜Windows_11_操作示意.mp4', '.mp4'],
      ['screen recording (1).MP4', '.MP4'],
      [`${'a'.repeat(121)}.mov`, '.mov'],
      ['素材🎬', ''],
      ['素材.非法后缀', '']
    ])('uploads %s using a safe handle while preserving bytes and the server response', async (name, extension) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, name: 'server-canonical-handle' }))
      const params = { name, content: BYTES }
      const result = await client.upload(params)

      const handle = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('name')!
      expect(handle).toMatch(/^[A-Za-z0-9._-]{1,120}$/)
      expect(handle).not.toBe(name)
      expect(extension ? handle.endsWith(extension) : !handle.includes('.')).toBe(true)
      expect(result).toMatchObject({ ok: true, data: { name: 'server-canonical-handle' } })
      expect(params.name).toBe(name)
      expect(new Uint8Array(fetchMock.mock.calls[0][1]?.body as ArrayBuffer)).toEqual(BYTES)
    })

    it.each(['clip_01-v2.mp4', `${'a'.repeat(116)}.mp4`, 'logo-1234.png'])(
      'preserves the already valid handle %s',
      async (name) => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ name }))
        expect(await client.upload({ name, content: BYTES })).toMatchObject({ ok: true, data: { name } })
        expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('name')).toBe(name)
      }
    )

    it.each(['', '   '])('rejects an empty upload name %j without sending', async (name) => {
      expect(await client.upload({ name, content: BYTES })).toMatchObject({
        ok: false,
        error: { category: 'validation' }
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects content larger than 500 MiB (524288000 bytes) before sending', async () => {
      const result = await client.upload({ name: 'big.bin', content: new Uint8Array(524288001) })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.category).toBe('validation')
        expect(result.error.outcomeUnknown).toBe(false)
      }
      // Must never issue a request for an oversized payload.
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not follow a redirect and surfaces an http error (token is not re-sent)', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'http://evil/x' } }))
      const result = await client.upload({ name: 'x.png', content: new Uint8Array([1]) })
      expect(result.ok).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      if (!result.ok) expect(result.error.category).toBe('http')
    })

    it('surfaces a server error without leaking the token into logs', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'))
      const result = await client.upload({ name: 'x.png', content: new Uint8Array([1]) })
      expect(result.ok).toBe(false)
      const logged = JSON.stringify([mockMainLoggerService.warn.mock.calls, mockMainLoggerService.error.mock.calls])
      expect(logged).not.toContain(TOKEN)
    })
  })

  it('never logs the service token', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await client.qaGet({ run: 'demo-run' })
    const logged = JSON.stringify([mockMainLoggerService.warn.mock.calls, mockMainLoggerService.error.mock.calls])
    expect(logged).not.toContain(TOKEN)
  })

  it('ttsOptionsGet 归一化 defaultVoice/lang 变体并保留其它字段', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        languages: [
          { id: 'zh', defaultVoice: 'v-zh' },
          { id: 'en', default_voice: 'v-en' }
        ],
        voices: [
          { id: 'v-zh', lang: 'zh', label: '中文' },
          { id: 'v-en', language: 'en', label: 'English' }
        ]
      })
    )
    const result = await client.ttsOptionsGet({})
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.data.languages).toEqual([
      { id: 'zh', default_voice: 'v-zh' },
      { id: 'en', default_voice: 'v-en' }
    ])
    expect(result.data.voices).toEqual([
      { id: 'v-zh', language: 'zh', label: '中文' },
      { id: 'v-en', language: 'en', label: 'English' }
    ])
  })

  it('ttsOptionsGet 读取完整目录且不发送未支持的筛选参数', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ languages: [], voices: [] }))
    await client.ttsOptionsGet({})
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/video/tts_options_get`)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({})
  })
})
