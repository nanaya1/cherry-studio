import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useOrgKnowledgeResource } from '../useOrgKnowledgeResource'

describe('组织资源请求隔离', () => {
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
