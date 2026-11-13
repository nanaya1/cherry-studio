import { describe, expect, it } from 'vitest'

import { industrialVideoRequestSchemas } from '../industrialVideo'

/**
 * 工业字幕最小适配的契约测试：
 *  - `subtitleLanguage` / `secondSubtitleLanguage` / `bilingualSubtitles` /
 *    `narrationFollowsSubtitles` 以 camelCase 进入 IPC（渲染端提交），主进程转 snake_case。
 *  - `industrial_video.video_start` 新增可选 `stage: 'plan'`，作为渲染端“只保存设置、不付费生成”的安全路径。
 */
describe('industrial_video IPC schema — 工业字幕与 stage plan', () => {
  it('video_start 接受字幕 camelCase 字段与 stage:"plan" 并透传', () => {
    const schema = industrialVideoRequestSchemas['industrial_video.video_start'].input
    const parsed = schema.parse({
      sessionId: 's1',
      run: 'r1',
      subtitleLanguage: 'en-US',
      secondSubtitleLanguage: 'ja-JP',
      bilingualSubtitles: true,
      narrationFollowsSubtitles: true,
      stage: 'plan'
    })
    expect(parsed).toMatchObject({
      subtitleLanguage: 'en-US',
      secondSubtitleLanguage: 'ja-JP',
      bilingualSubtitles: true,
      narrationFollowsSubtitles: true,
      stage: 'plan'
    })
  })

  it('video_start 缺省 stage 仍为合法（向后兼容生成路径）', () => {
    const schema = industrialVideoRequestSchemas['industrial_video.video_start'].input
    const parsed = schema.parse({ sessionId: 's1', run: 'r1' })
    expect(parsed).toMatchObject({ sessionId: 's1', run: 'r1' })
    expect((parsed as Record<string, unknown>).stage).toBeUndefined()
  })

  it('video_start 拒绝非法 stage 值', () => {
    const schema = industrialVideoRequestSchemas['industrial_video.video_start'].input
    expect(() => schema.parse({ sessionId: 's1', run: 'r1', stage: 'all' })).toThrow()
  })

  it('parse / estimate 同样接受字幕字段（来自 ivSettingsShape）', () => {
    const parseSchema = industrialVideoRequestSchemas['industrial_video.parse'].input
    const estimateSchema = industrialVideoRequestSchemas['industrial_video.estimate'].input
    expect(() => parseSchema.parse({ sessionId: 's1', subtitleLanguage: 'zh-CN', bilingualSubtitles: false })).not.toThrow()
    expect(() =>
      estimateSchema.parse({ sessionId: 's1', run: 'r1', subtitleLanguage: 'zh-CN', secondSubtitleLanguage: 'en-US' })
    ).not.toThrow()
  })

  it('video_start 严格拒绝未知字段', () => {
    const schema = industrialVideoRequestSchemas['industrial_video.video_start'].input
    expect(() => schema.parse({ sessionId: 's1', run: 'r1', unknown_field: 1 })).toThrow()
  })

  it('字幕语言必须是服务端固定 8 种之一', () => {
    const schema = industrialVideoRequestSchemas['industrial_video.video_start'].input
    expect(() => schema.parse({ sessionId: 's1', run: 'r1', subtitleLanguage: 'fr' })).toThrow()
  })
})
