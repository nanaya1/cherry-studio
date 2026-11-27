import { describe, expect, it } from 'vitest'

import {
  ActiveAgentChannelConfigSchemasByType,
  CreateAgentChannelSchema,
  DingTalkAgentChannelConfigSchema
} from '../agentChannels'

describe('DingTalk agent channel schemas', () => {
  it('accepts the default payload sent when adding a DingTalk channel', () => {
    const payload = {
      type: 'dingtalk',
      name: 'DingTalk',
      workspace: { type: 'system' },
      config: {
        client_id: '',
        client_secret: '',
        robot_code: '',
        card_template_id: '',
        allowed_chat_ids: [],
        allowed_user_ids: []
      },
      isActive: false
    }

    expect(CreateAgentChannelSchema.parse(payload)).toEqual(payload)
  })

  it('requires a robot code to enable a new DingTalk channel', () => {
    const schema = ActiveAgentChannelConfigSchemasByType.dingtalk
    const config = { client_id: 'client', client_secret: 'secret', robot_code: '', allowed_chat_ids: [] }

    expect(schema.safeParse(config).success).toBe(false)
    expect(schema.safeParse({ ...config, robot_code: 'robot-1' }).success).toBe(true)
  })

  it('rejects unknown DingTalk configuration fields', () => {
    expect(
      DingTalkAgentChannelConfigSchema.safeParse({
        client_id: '',
        client_secret: '',
        robot_code: '',
        unexpected: true
      }).success
    ).toBe(false)
  })
})
