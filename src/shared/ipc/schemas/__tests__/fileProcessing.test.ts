import { describe, expect, it } from 'vitest'

import { fileProcessingRequestSchemas } from '../fileProcessing'

describe('文件处理取消协议', () => {
  const route = fileProcessingRequestSchemas['file_processing.cancel_job']
  it('只接受非空任务 ID，拒绝未知字段', () => {
    expect(route.input.safeParse({ jobId: 'job-1' }).success).toBe(true)
    expect(route.input.safeParse({ jobId: '' }).success).toBe(false)
    expect(route.input.safeParse({ jobId: ' ' }).success).toBe(false)
    expect(route.input.safeParse({ jobId: 'job-1', path: '/tmp/source' }).success).toBe(false)
  })
  it('只接受 JobManager 定义的取消结果', () => {
    for (const outcome of ['cancelled', 'timed-out', 'not-cancellable']) {
      expect(route.output.safeParse({ outcome }).success).toBe(true)
    }
    expect(route.output.safeParse({ outcome: 'completed' }).success).toBe(false)
  })
})
