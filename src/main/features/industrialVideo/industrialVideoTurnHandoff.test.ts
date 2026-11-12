import type { PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { industrialVideoTurnHandoff } from './industrialVideoTurnHandoff'

function event(value: unknown, tool = 'ivideo_review_snapshot_get'): PostToolUseHookInput {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: `mcp__meacowork-tools__${tool}`,
    tool_response: { content: [{ type: 'text', text: JSON.stringify(value) }] },
    tool_input: { run: 'r1' },
    tool_use_id: 't1'
  } as PostToolUseHookInput
}
const handoff = {
  ok: true,
  end_turn: true,
  run: 'r1',
  workbench_url: 'https://video.example/workbench',
  message: '请在工作台确认后发送「开始生成视频」。'
}

describe('工业工作台本轮交接', () => {
  it('真实交接使用执行库停止信号，不依赖模型遵守提示', () => {
    expect(industrialVideoTurnHandoff('industrial-video', event(handoff))).toEqual({
      continue: false,
      stopReason: handoff.message
    })
  })
  it('未获批准的生成也结束本轮', () => {
    expect(industrialVideoTurnHandoff('industrial-video', event(handoff, 'ivideo_start'))).toMatchObject({
      continue: false
    })
  })
  it('下一轮没有交接结果时恢复执行，不保存停止状态', () => {
    industrialVideoTurnHandoff('industrial-video', event(handoff))
    expect(industrialVideoTurnHandoff('industrial-video', event({ ok: true, jobId: 'j1' }, 'ivideo_start'))).toEqual({})
  })
  it('普通会话、失败结果、其他工具和子代理不能触发主轮交接', () => {
    expect(industrialVideoTurnHandoff(undefined, event(handoff))).toEqual({})
    expect(industrialVideoTurnHandoff('industrial-video', event({ ...handoff, ok: false }))).toEqual({})
    expect(industrialVideoTurnHandoff('industrial-video', event(handoff, 'ivideo_parse'))).toEqual({})
    expect(industrialVideoTurnHandoff('industrial-video', { ...event(handoff), agent_id: 'child' })).toEqual({})
  })
  it('拒绝缺失链接及不可信协议，不提前结束失败交接', () => {
    for (const workbench_url of [undefined, '', 'javascript:alert(1)', 'https://user:pass@example.test']) {
      expect(industrialVideoTurnHandoff('industrial-video', event({ ...handoff, workbench_url }))).toEqual({})
    }
  })
})
