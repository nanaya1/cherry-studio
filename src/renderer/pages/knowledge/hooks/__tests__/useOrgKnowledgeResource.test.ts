import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useOrgKnowledgeResource } from '../useOrgKnowledgeResource'

describe('组织资源请求隔离', () => {
  it('旧 mutation 捕获的 refresh 在切库后不能重启旧 loader 或覆盖新库', async () => {
    const old = vi.fn(async () => '甲库内容')
    const next = vi.fn(async () => '乙库内容')
    const { result, rerender } = renderHook(({ load }) => useOrgKnowledgeResource(load), {
      initialProps: { load: old }
    })
    await waitFor(() => expect(result.current.data).toBe('甲库内容'))
    const staleRefresh = result.current.refresh
    rerender({ load: next })
    await waitFor(() => expect(result.current.data).toBe('乙库内容'))
    await act(async () => {
      await staleRefresh()
    })
    expect(result.current.data).toBe('乙库内容')
  })
  it('A→B→A 复用同一个 loader 时第一轮旧回调仍失效', async () => {
    let content = '甲库初稿'
    const old = vi.fn(async () => content)
    const next = vi.fn(async () => '乙库内容')
    const { result, rerender } = renderHook(({ load }) => useOrgKnowledgeResource(load), {
      initialProps: { load: old }
    })
    await waitFor(() => expect(result.current.data).toBe('甲库初稿'))
    const stale = result.current.refresh
    rerender({ load: next })
    await waitFor(() => expect(result.current.data).toBe('乙库内容'))
    content = '甲库新版'
    rerender({ load: old })
    await waitFor(() => expect(result.current.data).toBe('甲库新版'))
    content = '过期操作结果'
    await act(async () => {
      await stale()
    })
    expect(result.current.data).toBe('甲库新版')
  })

  it('切换知识库后忽略旧请求，避免旧正文覆盖新正文', async () => {
    let resolveOld!: (value: string) => void
    const old = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve
        })
    )
    const next = vi.fn(async () => '新账号正文')
    const { result, rerender } = renderHook(({ load }) => useOrgKnowledgeResource(load), {
      initialProps: { load: old }
    })
    rerender({ load: next })
    await waitFor(() => expect(result.current.data).toBe('新账号正文'))
    await act(async () => resolveOld('旧账号正文'))
    expect(result.current.data).toBe('新账号正文')
  })
})
