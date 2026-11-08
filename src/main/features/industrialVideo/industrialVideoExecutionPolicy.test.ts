import { describe, expect, it } from 'vitest'

import { assertIndustrialVideoRuntime, isIndustrialVideoToolAllowed } from './industrialVideoExecutionPolicy'

describe('industrial video execution policy', () => {
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
