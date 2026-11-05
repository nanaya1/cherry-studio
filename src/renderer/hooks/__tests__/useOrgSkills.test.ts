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
      if (route === 'enterprise.skills.list_resources') return { skills: [], installedKeys: [] }
      if (route === 'enterprise.skills.list_disabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
  })

  it('同slug技能按稳定键安装且只更新对应安装状态', async () => {
    const first = `java-resource:${'a'.repeat(32)}:skill:1`
    const second = `java-resource:${'a'.repeat(32)}:skill:2`
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list_resources')
        return {
          skills: [first, second].map((resourceKey) => ({
            resourceKey,
            slug: 'same',
            name: '同名',
            description: '',
            version: '1',
            contentHash: 'hash'
          })),
          installedKeys: []
        }
      if (route === 'enterprise.skills.install_resource') return { ok: true }
      if (route === 'enterprise.skills.list_disabled') return { disabled: [] }
      throw new Error('旧资源路由不得调用')
    })
    const { result } = renderHook(() => useOrgSkills(true))
    await waitFor(() => expect(result.current.skills).toHaveLength(2))
    await act(async () => {
      await result.current.install(first)
    })
    expect(result.current.installedSlugs.has(first)).toBe(true)
    expect(result.current.installedSlugs.has(second)).toBe(false)
    expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.install_resource', { resourceKey: first })
  })

  it('卸载只移除目标稳定键，不调用旧deleted上报路由', async () => {
    const first = `java-resource:${'a'.repeat(32)}:skill:1`
    const second = `java-resource:${'a'.repeat(32)}:skill:2`
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list_resources') return { skills: [], installedKeys: [first, second] }
      if (route === 'enterprise.skills.list_disabled') return { disabled: [] }
      if (route === 'enterprise.skills.remove_resource') return { ok: true }
      throw new Error('不得使用旧删除上报代替卸载')
    })
    const { result } = renderHook(() => useOrgSkills(true))
    await waitFor(() => expect(result.current.installedSlugs.size).toBe(2))
    await act(async () => {
      await result.current.remove(first)
    })
    expect(result.current.installedSlugs.has(first)).toBe(false)
    expect(result.current.installedSlugs.has(second)).toBe(true)
    expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.remove_resource', { resourceKey: first })
  })

  it('does not request while signed out and refetches after sign-in', async () => {
    const { rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: false } })

    expect(mocks.request).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.list_resources')
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
          installedKeys: string[]
        }) => void)
      | undefined
    mocks.request.mockImplementation(
      (route: string) =>
        new Promise((resolve, reject) => {
          if (route === 'enterprise.skills.list_resources') resolveList = resolve
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
      installedKeys: []
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.skills).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('clears a previous request error while signed out and recovers after sign-in', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Invalid input for enterprise.skills.list_resources'))
    const { result, rerender } = renderHook(({ enabled }) => useOrgSkills(enabled), { initialProps: { enabled: true } })

    await waitFor(() => expect(result.current.error).toBe('Invalid input for enterprise.skills.list_resources'))

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.error).toBeNull())

    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.skills.list_resources') return { skills: [], installedKeys: [] }
      if (route === 'enterprise.skills.list_disabled') return { disabled: [] }
      throw new Error(`unexpected route: ${route}`)
    })
    await act(async () => rerender({ enabled: true }))

    await waitFor(() => expect(result.current.error).toBeNull())
    expect(mocks.request).toHaveBeenCalledWith('enterprise.skills.list_resources')
  })
})
