import { describe, expect, it, vi } from 'vitest'

import { canAnalyzeMaterials, readMaterialArtifact } from './industrialVideoMaterials'

// 防止空解析产物被当成成功，以及部分失败未经确认就发起分析。
describe('工业视频资料合同', () => {
  it('读取完整 Markdown 产物，空内容与非法产物拒绝成功', async () => {
    const read = vi.fn(async () => '# 装配要求\n扭矩 20Nm')
    await expect(
      readMaterialArtifact({ artifact: { kind: 'file', format: 'markdown', path: '/tmp/manual.md' } }, read)
    ).resolves.toBe('# 装配要求\n扭矩 20Nm')
    await expect(
      readMaterialArtifact({ artifact: { kind: 'text', format: 'plain', text: '  ' } }, read)
    ).rejects.toThrow()
    await expect(readMaterialArtifact({ artifact: { kind: 'file' } }, read)).rejects.toThrow()
  })

  it('部分失败须明确同意；全部失败、解析中、空需求都不可分析', () => {
    const ready = { status: 'ready' as const, text: '操作步骤' }
    const failed = { status: 'failed' as const }
    expect(canAnalyzeMaterials('装配视频', [ready], false)).toBe(true)
    expect(canAnalyzeMaterials('装配视频', [ready, failed], false)).toBe(false)
    expect(canAnalyzeMaterials('装配视频', [ready, failed], true)).toBe(true)
    expect(canAnalyzeMaterials('装配视频', [failed], true)).toBe(false)
    expect(canAnalyzeMaterials('装配视频', [ready, { status: 'parsing' }], true)).toBe(false)
    expect(canAnalyzeMaterials(' ', [ready], true)).toBe(false)
    expect(canAnalyzeMaterials('装配视频', [], true)).toBe(false)
  })
})
