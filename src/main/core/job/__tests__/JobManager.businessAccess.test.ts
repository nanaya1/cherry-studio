import { setupTestDatabase } from '@test-helpers/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { jobTable } from '@data/db/schemas/job'
import { jobService } from '@data/services/JobService'
import { BaseService } from '@main/core/lifecycle/BaseService'
import { SchedulerService } from '@main/core/scheduler/SchedulerService'
import { DataApiError, ErrorCode } from '@shared/data/api/errors'

import { JobManager } from '../JobManager'
import { DispatchQueue } from '../runtime/DispatchQueue'

// These tests catch a mutex-wait admission bypass and denied executions being retried.
describe('JobManager business access', () => {
  const dbh = setupTestDatabase()
  let jobs: JobManager
  let scheduler: SchedulerService

  beforeEach(() => {
    BaseService.resetInstances()
    jobs = new JobManager()
    scheduler = new SchedulerService()
    const get = application.get.bind(application)
    vi.spyOn(application, 'get').mockImplementation(((name: string) => {
      if (name === 'PowerService') return { preventSleep: () => ({ dispose() {} }) }
      if (name === 'SchedulerService') return scheduler
      return get(name as never)
    }) as typeof application.get)
  })

  afterEach(async () => {
    await jobs._doStop()
    await scheduler._doStop()
    vi.restoreAllMocks()
    BaseService.resetInstances()
  })

  it('rejects new business jobs but leaves infrastructure and cleanup executable', async () => {
    const denied = new Error('Business access denied')
    vi.spyOn(application, 'assertTaskStartAllowed').mockImplementation(() => {
      throw denied
    })
    const execute = async () => 'done'
    jobs.registerHandler('agent.task', { recovery: 'abandon', execute })
    jobs.registerHandler('file.contenthash-backfill', { recovery: 'retry', execute })
    jobs.registerHandler('trash.purge', { recovery: 'retry', execute })
    expect(() => jobs.enqueue('agent.task', {} as never)).toThrow(denied)
    expect(jobService.list({ type: 'agent.task' })).toEqual([])
    const backfill = jobs.enqueue('file.contenthash-backfill', {})
    const cleanup = jobs.enqueue('trash.purge', {})
    expect((await backfill.finished).status).toBe('completed')
    expect((await cleanup.finished).status).toBe('completed')
  })

  it('does not claim a business job after access expires while waiting for its queue mutex', async () => {
    const denied = new Error('Business access denied')
    let allowed = true
    vi.spyOn(application, 'assertTaskStartAllowed').mockImplementation(() => {
      if (!allowed) throw denied
    })
    const execute = vi.fn(async () => 'must-not-run')
    jobs.registerHandler('agent.task', { recovery: 'abandon', execute })
    const queue = new DispatchQueue('shared-queue', 1)
    ;(jobs as unknown as { queues: Map<string, DispatchQueue> }).queues.set(queue.name, queue)
    const [row] = dbh.db
      .insert(jobTable)
      .values({
        type: 'agent.task',
        queue: queue.name,
        status: 'pending',
        input: {},
        scheduledAt: Date.now()
      })
      .returning()
      .all()
    const release = await queue.mutex.acquire()
    const dispatch = jobs.dispatch(queue.name)
    allowed = false
    release()
    await dispatch
    expect(jobService.getById(row.id)?.status).toBe('pending')
    expect(execute).not.toHaveBeenCalled()
    await jobs.cancel(row.id, 'access denied')
    expect(jobService.getById(row.id)?.status).toBe('cancelled')
  })

  it('settles an authorization-denied handler without retrying its business work', async () => {
    const denied = new DataApiError(ErrorCode.PERMISSION_DENIED, 'Business access denied', 403)
    jobs.registerHandler('agent.task', {
      recovery: 'abandon',
      defaultRetryPolicy: { maxAttempts: 3, backoff: 'fixed', baseDelayMs: 1, maxDelayMs: 1 },
      execute: async () => {
        vi.spyOn(application, 'assertBusinessAccess').mockImplementation(() => {
          throw denied
        })
        throw denied
      }
    })
    const job = jobs.enqueue('agent.task', {} as never)
    const terminal = await job.finished
    expect(terminal.status).toBe('failed')
    expect(terminal.error?.retryable).toBe(false)
    expect(jobService.getById(job.id)?.attempt).toBe(0)
  })
})
