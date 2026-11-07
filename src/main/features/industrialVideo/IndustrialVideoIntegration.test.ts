import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { BaseService } from '@main/core/lifecycle'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import { IndustrialVideoClient } from './IndustrialVideoClient'
import { IndustrialVideoDownloader } from './IndustrialVideoDownload'
import { IndustrialVideoService } from './IndustrialVideoService'

let dir: string
let service: IndustrialVideoService
let store: Record<string, unknown>
let calls: Array<{ operation: string; body: Record<string, unknown> }>
let jobs: Record<string, { run: string; status: string }>
let counter: number
const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])

function createService(useRealWorkspace = false) {
  const instance = new IndustrialVideoService()
  instance.setTestDeps({
    resolveConfig: () => ({ baseUrl: 'https://industrial.test', token: 'mock-secret', timeoutMs: 1000 }),
    getSession: (id) => ({ id, featureKind: 'industrial-video', workspaceId: 'workspace' }) as AgentSessionEntity,
    ...(useRealWorkspace ? {} : { getWorkspacePath: () => dir }),
    getPersist: (key) => (store[key] ?? {}) as never,
    setPersist: (key, value) => {
      store[key] = value
    },
    createClient: (config) => new IndustrialVideoClient(config),
    createDownloader: (config) => new IndustrialVideoDownloader(config)
  })
  return instance
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'industrial-integration-'))
  BaseService.resetInstances()
  store = {}
  calls = []
  jobs = {}
  counter = 0
  service = createService()
  vi.mocked(net.fetch).mockImplementation(async (url, init) => {
    const parsed = new URL(String(url))
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer mock-secret')
    expect(init?.redirect).toBe('manual')
    if (parsed.pathname === '/download')
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    const operation = parsed.pathname.split('/').pop()!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ operation, body })
    let result: Record<string, unknown> = {}
    switch (operation) {
      case 'run_create':
        result = { run: `run-${++counter}` }
        break
      case 'media_upload':
        result = { name: 'motor.png' }
        break
      case 'logo_upload':
        result = { name: 'logo.png' }
        break
      case 'video_start':
        if (body.estimate_only) result = { estimated_cost: 12 }
        else {
          const id = `job-${++counter}`
          jobs[id] = { run: String(body.run), status: 'done' }
          result = { job_id: id }
        }
        break
      case 'job_get':
        result = jobs[String(body.job_id)] ?? {}
        break
      case 'planning_context_get':
        result = { input_fingerprint: 'fingerprint-1', storyboard_sha256: '' }
        break
      case 'storyboard_submit':
        result = { submitted: true, review_required: true }
        break
      case 'scene_retry': {
        const id = `job-${++counter}`
        jobs[id] = { run: String(body.run), status: 'done' }
        result = { job_id: id }
        break
      }
      case 'qa_get':
        result = { failed_scenes: [2] }
        break
      case 'preview_create':
        result = { final_path: `${body.run}/final.mp4` }
        break
    }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
  })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('工业视频模拟HTTP完整集成', () => {
  const dbh = setupTestDatabase()

  it.each(['system', 'user'])('%s 工作区通过真实工作区查询下载成片，且拒绝其他会话的项目', async (type) => {
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: 'workspace', name: '视频工作区', path: dir, type, orderKey: 'a0' })
      .run()
    service = createService(true)
    const { run } = await service.runCreate({ sessionId: 's', baseName: '产品' })

    const download = await service.downloadArtifact({ sessionId: 's', run, path: `${run}/final.mp4` })
    expect(new Uint8Array(await readFile(download.filePath))).toEqual(bytes)
    expect(download.filePath).toBe(join(dir, 'final.mp4'))

    const sent = vi.mocked(net.fetch).mock.calls.length
    await expect(
      service.downloadArtifact({ sessionId: 'foreign', run, path: `${run}/final.mp4` })
    ).rejects.toMatchObject({
      code: 'IVIDEO_RUN_INVALID'
    })
    expect(vi.mocked(net.fetch).mock.calls).toHaveLength(sent)
  })

  it('上传→解析→规划→提交→预检→明确生成→恢复→重试→合成→下载贯穿真实Client与Service', async () => {
    const media = await service.mediaUpload({ sessionId: 's', contentBase64: 'YQ==', caption: '电机' })
    const logo = await service.logoUpload({ sessionId: 's', contentBase64: 'Yg==' })
    const { run } = await service.runCreate({ sessionId: 's', baseName: '产品视频' })
    const parsed = await service.parse({
      sessionId: 's',
      run,
      texts: [{ text: '真实产品事实' }],
      media: [{ name: media.name, caption: '电机' }],
      logo
    })
    await service.jobGet({ sessionId: 's', jobId: parsed.jobId })
    const context = await service.planningContextGet({ sessionId: 's', run })
    await service.storyboardSubmit({
      sessionId: 's',
      run,
      storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景', duration: 5 }] },
      expectedInputFingerprint: String(context.input_fingerprint),
      expectedStoryboardSha256: String(context.storyboard_sha256)
    })
    await service.estimate({ sessionId: 's', run, voice: 'zh-CN-XiaoxiaoNeural' })
    expect(
      calls.filter(
        ({ operation, body }) => operation === 'video_start' && body.stage === 'video' && !body.estimate_only
      )
    ).toHaveLength(0)
    const generated = await service.videoStart({ sessionId: 's', run, voice: 'zh-CN-XiaoxiaoNeural' })
    expect(service.getRecords({ sessionId: 's' })?.jobId).toBe(generated.jobId)
    await service.jobGet({ sessionId: 's', jobId: generated.jobId })
    await service.qaGet({ sessionId: 's', run })
    const retry = await service.sceneRetry({ sessionId: 's', run, sceneId: 2 })
    await service.jobGet({ sessionId: 's', jobId: String(retry.job_id) })
    const assembled = await service.assemble({ sessionId: 's', run })
    await service.jobGet({ sessionId: 's', jobId: assembled.jobId })
    const preview = await service.previewCreate({ sessionId: 's', run })
    const download = await service.downloadArtifact({ sessionId: 's', run, path: String(preview.final_path) })
    expect(new Uint8Array(await readFile(download.filePath))).toEqual(bytes)
    expect(service.getRecords({ sessionId: 's' })).toMatchObject({ version: 1, run, state: 'done' })
    expect(JSON.stringify(store)).not.toContain('mock-secret')
    await expect(
      service.downloadArtifact({ sessionId: 'foreign', run, path: String(preview.final_path) })
    ).rejects.toMatchObject({ code: 'IVIDEO_RUN_INVALID' })
  })

  it('生成连接中断持久化未知结果，重开同一缓存仍阻止再次计费提交', async () => {
    const { run } = await service.runCreate({ sessionId: 's', baseName: '产品' })
    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('connection lost after accept'))
    await expect(service.videoStart({ sessionId: 's', run })).rejects.toMatchObject({ code: 'IVIDEO_HTTP_ERROR' })
    const sent = vi.mocked(net.fetch).mock.calls.length
    BaseService.resetInstances()
    service = createService()
    await expect(service.videoStart({ sessionId: 's', run })).rejects.toMatchObject({
      code: 'IVIDEO_SUBMISSION_UNKNOWN'
    })
    expect(vi.mocked(net.fetch).mock.calls).toHaveLength(sent)
    expect(service.getRecords({ sessionId: 's' })?.unknownSubmissions).toHaveLength(1)
  })
})
