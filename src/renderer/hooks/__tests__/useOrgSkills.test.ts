// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  invalidate: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: mocks.request } }))
vi.mock('@renderer/hooks/useSkills', () => ({ useInvalidateSkills: () => mocks.invalidate }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), error: vi.fn() }) }
}))

import { useOrgSkills } from '../useOrgSkills'

describe('useOrgSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list') return { skills: [], installedSlugs: [] }
      if (route === 'enterprise.skills.listDisabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
  })

  it('does not request while signed out and refetches after sign-in', async () => {
    const { rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: false } })

    expect(mocks.request).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.list', { force: true })
    })
  })

  it('discards an in-flight response after signing out', async () => {
    let resolveList:
      | ((value: {
          skills: Array<{
            slug: string
            name: string
            description: string
            version: string
            contentHash: string
            downloadUrl: string
          }>
          installedSlugs: string[]
        }) => void)
      | undefined
    mocks.request.mockImplementation(
      (route: string) =>
        new Promise((resolve, reject) => {
          if (route === 'enterprise.skills.list') resolveList = resolve
          else reject(new Error(`unexpected route: ${route}`))
        })
    )
    const { result, rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: true } })

    await waitFor(() => expect(resolveList).toBeTypeOf('function'))
    rerender({ enabled: false })
    resolveList?.({
      skills: [
        {
          slug: 'late-skill',
          name: '迟到技能',
          description: '',
          version: '1.0.0',
          contentHash: 'hash',
          downloadUrl: '/download'
        }
      ],
      installedSlugs: []
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.skills).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('clears a previous request error while signed out and recovers after sign-in', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Invalid input for enterprise.skills.list'))
    const { result, rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: true } })

    await waitFor(() => expect(result.current.error).toBe('Invalid input for enterprise.skills.list'))

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.error).toBeNull())

    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list') return { skills: [], installedSlugs: [] }
      if (route === 'enterprise.skills.listDisabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
    await act(async () => rerender({ enabled: true }))

    await waitFor(() => expect(result.current.error).toBeNull())
    expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.list', { force: true })
  })

  it('starts with available false before any directory response', async () => {
    const { result } = renderHook(() => useOrgSkills(true))
    expect(result.current.available).toBe(false)
    // 让在途请求解析完成，避免 act 警告
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('sets available true on a successful list response, including an empty directory', async () => {
    const { result } = renderHook(() => useOrgSkills(true))
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.skills).toEqual([])
  })

  it('resets available and the skill list when disabled', async () => {
    const skill = {
      slug: 's1',
      name: 'S1',
      description: '',
      version: '1.0.0',
      contentHash: 'hash',
      downloadUrl: '/download'
    }
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list') return { skills: [skill], installedSlugs: [] }
      if (route === 'enterprise.skills.listDisabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
    const { result, rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: true } })

    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.skills).toEqual([skill])

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.skills).toEqual([])
  })

  it('keeps the list and available=true when a refresh fails after a successful load', async () => {
    const skill = {
      slug: 's1',
      name: 'S1',
      description: '',
      version: '1.0.0',
      contentHash: 'hash',
      downloadUrl: '/download'
    }
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list') return { skills: [skill], installedSlugs: [] }
      if (route === 'enterprise.skills.listDisabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
    const { result } = renderHook(() => useOrgSkills(true))

    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.skills).toEqual([skill])

    mocks.request.mockRejectedValueOnce(new Error('network down'))
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.skills).toEqual([skill])
    expect(result.current.available).toBe(true)
    expect(result.current.error).toBe('network down')
  })

  it('leaves available false when the initial directory request fails', async () => {
    mocks.request.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useOrgSkills(true))

    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.available).toBe(false)
    expect(result.current.skills).toEqual([])
  })
})
