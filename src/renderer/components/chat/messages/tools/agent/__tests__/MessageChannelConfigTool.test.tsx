import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { NormalToolResponse } from '@renderer/types/mcpTool'

vi.mock('../AgentExecutionTimeline', () => ({
  AgentExecutionTimeline: ({ toolResponse }: { toolResponse: NormalToolResponse }) => (
    <div data-testid="tool-details">{JSON.stringify(toolResponse.response)}</div>
  )
}))

vi.mock('@renderer/components/chat/messages/blocks/ImageBlock', () => ({
  default: ({ images }: { images: string[] }) => <img alt="channel authentication QR code" src={images[0]} />
}))

const { MessageChannelConfigTool } = await import('../MessageChannelConfigTool')

function response(output: unknown, serverName = 'meacowork-tools'): NormalToolResponse {
  const runtimeName = `mcp__${serverName}__config`
  return {
    id: 'config-call',
    toolCallId: 'config-call',
    tool: {
      id: runtimeName,
      name: runtimeName,
      type: 'mcp'
    },
    arguments: { action: 'add_channel', type: 'wechat', name: 'WeChat', auth_mode: 'qr' },
    response: output,
    status: 'done'
  }
}

describe('MessageChannelConfigTool', () => {
  it('renders a channel authentication QR code outside the tool details', () => {
    render(
      <MessageChannelConfigTool
        toolResponse={response({
          content: [
            { type: 'text', text: 'Scan this QR code' },
            { type: 'image', data: 'BASE64', mimeType: 'image/png' }
          ]
        })}
      />
    )

    expect(screen.getByRole('img', { name: 'channel authentication QR code' })).toHaveAttribute(
      'src',
      'data:image/png;base64,BASE64'
    )
    expect(screen.getByTestId('tool-details')).not.toHaveTextContent('BASE64')
  })

  it('keeps rendering historical cherry-tools channel QR results', () => {
    render(
      <MessageChannelConfigTool
        toolResponse={response({ content: [{ type: 'image', data: 'LEGACY', mimeType: 'image/png' }] }, 'cherry-tools')}
      />
    )

    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,LEGACY')
  })

  it('uses the standard config tool renderer when no QR code is returned', () => {
    render(
      <MessageChannelConfigTool
        toolResponse={response({
          content: [{ type: 'text', text: 'Channel updated' }]
        })}
      />
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByTestId('tool-details')).toHaveTextContent('Channel updated')
  })
})
