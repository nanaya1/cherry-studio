import { describe, expect, it } from 'vitest'

import { assertIndustrialVideoRuntime, INDUSTRIAL_VIDEO_PRODUCTION_PROMPT, isIndustrialVideoToolAllowed } from './industrialVideoExecutionPolicy'

describe('industrial video execution policy', () => {
  it('要求按字幕任务编写主语言与译文，设置同步不得生成且仍需网页审核', () => {
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('subtitle_translation_task')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('translations')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('stage')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('不触发收费生成')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('网页')
  })
  it.each(['pi', 'dsh'])('rejects unguarded industrial runtime %s', (runtime) => {
    expect(() => assertIndustrialVideoRuntime('industrial-video', runtime)).toThrow('Claude Code')
  })
  it('preserves ordinary runtime selection and guarded Claude sessions', () => {
    expect(() => assertIndustrialVideoRuntime('general', 'pi')).not.toThrow()
    expect(() => assertIndustrialVideoRuntime('general', 'dsh')).not.toThrow()
    expect(() => assertIndustrialVideoRuntime('industrial-video', 'claude-code')).not.toThrow()
  })
  it('does not authorize server spoofing or future tools by prefix', () => {
    for (const name of ['ivideo_start', 'mcp__external__ivideo_start', 'mcp__meacowork-tools__ivideo_future']) {
      expect(isIndustrialVideoToolAllowed(name)).toBe(false)
    }
    expect(isIndustrialVideoToolAllowed('AskUserQuestion')).toBe(true)
    expect(isIndustrialVideoToolAllowed('mcp__cherry-tools__ivideo_start')).toBe(true)
  })
})
