import { describe, expect, it } from 'vitest'

import { mergeIndustrialVideoInput } from './IndustrialVideoRevision'

describe('工业视频全量输入', () => {
  it('补充素材保留旧文本、Logo 和设置，并以服务端句柄去重', () => {
    const previous = {
      texts: [{ text: '原始资料' }],
      media: [{ name: 'old.png', caption: '旧素材' }],
      logo: { name: 'brand.png' },
      targetDurationS: 30
    }
    const next = mergeIndustrialVideoInput(previous, {
      media: [{ name: 'new.png', caption: '新增' }],
      targetDurationS: 20
    })
    expect(next).toEqual({
      ...previous,
      targetDurationS: 20,
      media: [...previous.media, { name: 'new.png', caption: '新增' }]
    })
    expect(mergeIndustrialVideoInput(next, { media: [{ name: 'old.png', caption: '更新描述' }] }).media).toEqual([
      { name: 'old.png', caption: '更新描述' },
      { name: 'new.png', caption: '新增' }
    ])
    expect(previous.media).toEqual([{ name: 'old.png', caption: '旧素材' }])
  })

  it('显式清空 Logo 生效，空增量不能隐式丢弃素材，本地路径不能充当句柄', () => {
    expect(
      mergeIndustrialVideoInput(
        { media: [{ name: 'old', caption: '旧' }], logo: { name: 'logo' } },
        { media: [], logo: null }
      )
    ).toMatchObject({ media: [{ name: 'old', caption: '旧' }], logo: null })
    expect(() => mergeIndustrialVideoInput({}, { media: [{ name: '/tmp/local.png', caption: '未上传' }] })).toThrow()
  })
})
