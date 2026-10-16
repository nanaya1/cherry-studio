import { describe, expect, it, vi } from 'vitest'

import { inviteAfterShare, parseRecipientId, previewText } from '../sharing'

describe('组织知识库分享边界', () => {
  it.each(['0', '-1', '1.2', '1e3', '9007199254740992', '', 'abc'])('拒绝无效用户 ID %s', (value) => {
    expect(parseRecipientId(value)).toBeNull()
  })

  it('接受安全正整数并去除首尾空白', () => {
    expect(parseRecipientId(' 1024 ')).toBe(1024)
  })

  it.each(['failure', 'unknown'] as const)('文件 %s 时保留结果且不发送邀请', async (status) => {
    const invite = vi.fn()
    const result = {
      shareId: 'orgkb:space',
      completion: 'incomplete' as const,
      files: [{ fileName: 'a.pdf', status, fileId: null, chunkCount: null, error: '上传未完成' }]
    }
    expect(await inviteAfterShare(result, 1024, invite)).toBe(false)
    expect(invite).not.toHaveBeenCalled()
  })

  it.each(['incomplete', 'unconfirmed'] as const)('%s 即使已有成功文件也阻断邀请', async (completion) => {
    const invite = vi.fn()
    expect(
      await inviteAfterShare(
        {
          shareId: 'orgkb:space',
          completion,
          files: [{ fileName: 'a', status: 'success', fileId: 'f', chunkCount: 1, error: null }]
        },
        1024,
        invite
      )
    ).toBe(false)
    expect(invite).not.toHaveBeenCalled()
  })

  it('无文件结果不能视为上传完成', async () => {
    const invite = vi.fn()
    expect(await inviteAfterShare({ shareId: 'orgkb:space', completion: 'unconfirmed', files: [] }, 1024, invite)).toBe(
      false
    )
    expect(invite).not.toHaveBeenCalled()
  })

  it('全部成功后邀请到返回的共享副本', async () => {
    const invite = vi.fn().mockResolvedValue(undefined)
    expect(
      await inviteAfterShare(
        {
          shareId: 'orgkb:space',
          completion: 'completed',
          files: [{ fileName: 'a.md', status: 'success', fileId: 'orgkb:file', chunkCount: 2, error: null }]
        },
        1024,
        invite
      )
    ).toBe(true)
    expect(invite).toHaveBeenCalledWith({ baseId: 'orgkb:space', userId: 1024, expireDays: 7 })
  })

  it('inline 或二进制结果不伪装成成功正文', () => {
    expect(previewText({ kind: 'inline', fileName: 'a.pdf', mimeType: 'application/pdf', content: '' })).toBeNull()
    expect(
      previewText({ kind: 'binary', fileName: 'a.html', mimeType: 'text/html', content: '<script>bad()</script>' })
    ).toBeNull()
    expect(previewText({ kind: 'text', fileName: 'a.txt', mimeType: 'text/plain', content: '正文' })).toBe('正文')
  })
})
