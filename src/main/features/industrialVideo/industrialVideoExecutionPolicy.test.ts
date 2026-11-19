import { describe, expect, it } from 'vitest'

import {
  assertIndustrialVideoRuntime,
  INDUSTRIAL_VIDEO_PRODUCTION_PROMPT,
  isIndustrialVideoToolAllowed
} from './industrialVideoExecutionPolicy'

describe('industrial video execution policy', () => {
  it('允许只读分析上传附件，同时拒绝执行、写入和外部生成工具', () => {
    expect(isIndustrialVideoToolAllowed('Read')).toBe(true)
    for (const name of [
      'Bash',
      'Write',
      'Edit',
      'Skill',
      'Task',
      'Agent',
      'mcp__external__Read',
      'mcp__external__video_generate'
    ]) {
      expect(isIndustrialVideoToolAllowed(name)).toBe(false)
    }
  })
  it('要求串行完成分镜阶段，不自动估价/批准/生成视频且审核走真实按钮', () => {
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('ivideo_storyboard_stage_task_get')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('ivideo_storyboard_stage_submit')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('不得自动估价、批准或生成视频')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('不使用 AskUserQuestion 替代真实按钮')
    expect(INDUSTRIAL_VIDEO_PRODUCTION_PROMPT).toContain('ivideo_cowork_review_get')
    // 字幕双语不进静态提示词：语言选择由设置与服务端动态 copy 任务决定，客户端只承诺「配音字幕走业务服务」。
  })
  it('参数差异通过本轮原生选择确认，不替代审核或要求补发消息', () => {
    const clarification = INDUSTRIAL_VIDEO_PRODUCTION_PROMPT.split('## 制作参数差异确认')[1]
    expect(clarification).toBeDefined()
    for (const rule of [
      'AskUserQuestion',
      '初始设置 → 本次识别值',
      '采用本次参数',
      '保留初始设置',
      '取消',
      '同一个问题',
      '不要求用户再发送',
      '未提及或无法明确识别',
      '不代表全文或分镜审核通过',
      '版本冲突'
    ]) {
      expect(clarification).toContain(rule)
    }
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
