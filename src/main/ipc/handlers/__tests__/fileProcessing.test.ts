import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock } = vi.hoisted(() => ({ appGetMock: vi.fn() }))
vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { fileProcessingHandlers } from '../fileProcessing'

const cancelJob = vi.fn()
const fileProcessingService = {
  startJob: vi.fn(),
  listAvailableProcessors: vi.fn(),
  checkOpenMineruConnectivity: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  appGetMock.mockImplementation((name: string) => {
    if (name === 'JobManager') return { cancel: cancelJob }
    if (name === 'FileProcessingService') return fileProcessingService
    throw new Error(`Unexpected application.get(${name})`)
  })
})

// File-processing handlers ignore IpcContext (they act on shared business data, not the
// caller's window), so the senderId value is irrelevant — pass a stable stub.
const ctx = { senderId: 'w1' }

type In<R extends keyof typeof fileProcessingHandlers> = Parameters<(typeof fileProcessingHandlers)[R]>[0]

describe('fileProcessingHandlers', () => {
  it('取消归属任务并保留取消超时结果与失败', async () => {
    cancelJob.mockResolvedValueOnce({ outcome: 'timed-out' }).mockRejectedValueOnce(new Error('任务不存在'))
    await expect(fileProcessingHandlers['file_processing.cancel_job']({ jobId: 'job-1' }, ctx)).resolves.toEqual({
      outcome: 'timed-out'
    })
    expect(cancelJob).toHaveBeenCalledWith('job-1')
    await expect(fileProcessingHandlers['file_processing.cancel_job']({ jobId: 'missing' }, ctx)).rejects.toThrow(
      '任务不存在'
    )
  })
  it('start_job forwards the input and returns the JobSnapshot', async () => {
    const input = {
      feature: 'image_to_text',
      file: { kind: 'entry', entryId: 'e1' },
      processorId: 'tesseract'
    } as In<'file_processing.start_job'>
    const snapshot = { id: 'job-1' }
    fileProcessingService.startJob.mockResolvedValue(snapshot)

    const result = await fileProcessingHandlers['file_processing.start_job'](input, ctx)

    expect(fileProcessingService.startJob).toHaveBeenCalledWith(input)
    expect(result).toBe(snapshot)
  })

  it('list_available_processors takes no input and returns the processor list', async () => {
    const list = { processorIds: ['tesseract'] }
    fileProcessingService.listAvailableProcessors.mockReturnValue(list)

    const result = await fileProcessingHandlers['file_processing.list_available_processors'](undefined, ctx)

    expect(fileProcessingService.listAvailableProcessors).toHaveBeenCalledWith()
    expect(result).toBe(list)
  })

  it('Open MinerU check_connectivity takes no input and returns the verdict', async () => {
    fileProcessingService.checkOpenMineruConnectivity.mockResolvedValue(false)

    const result = await fileProcessingHandlers['file_processing.open_mineru.check_connectivity'](undefined, ctx)

    expect(fileProcessingService.checkOpenMineruConnectivity).toHaveBeenCalledWith()
    expect(result).toBe(false)
  })
})
