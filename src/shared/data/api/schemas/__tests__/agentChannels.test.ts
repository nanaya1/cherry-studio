import { describe, expect, it } from 'vitest'

import { CreateAgentChannelSchema, DingTalkAgentChannelConfigSchema } from '../agentChannels'

describe('DingTalk agent channel schemas', () => {
  it('accepts the default payload sent when adding a DingTalk channel', () => {
    const payload = {
      type: 'dingtalk',
      name: 'DingTalk',
      workspace: { type: 'system' },
      config: {
        client_id: '',
        client_secret: '',
        allowed_chat_ids: [],
        require_mention: true
      },
      isActive: false
    }

    expect(CreateAgentChannelSchema.parse(payload)).toEqual(payload)
  })

  it('enables a DingTalk channel without robot_code (defaults to client_id)', () => {
    const payload = {
      type: 'dingtalk',
      name: 'DingTalk',
      workspace: { type: 'system' },
      config: { client_id: 'client', client_secret: 'secret', allowed_chat_ids: [], require_mention: true },
      isActive: true
    }
    expect(CreateAgentChannelSchema.safeParse(payload).success).toBe(true)
    expect(
      CreateAgentChannelSchema.safeParse({
        ...payload,
        config: { ...payload.config, robot_code: 'robot-1' }
      }).success
    ).toBe(true)
  })

  it('rejects unknown DingTalk configuration fields', () => {
    expect(
      DingTalkAgentChannelConfigSchema.safeParse({
        client_id: '',
        client_secret: '',
        unexpected: true
      }).success
    ).toBe(false)
  })
})
