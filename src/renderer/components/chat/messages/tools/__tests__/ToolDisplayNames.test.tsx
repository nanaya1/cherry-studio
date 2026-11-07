import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES } from '@renderer/pages/industrialVideo/industrialVideoToolDisplayNames'

import { MessageListProvider } from '../../MessageListProvider'
import { defaultMessageRenderConfig, type MessageListProviderValue } from '../../types'
import { UnknownToolRenderer } from '../agent/UnknownToolRenderer'
import MessageMcpTool from '../mcp/MessageMcpTool'
import type * as GenericTools from '../shared/GenericTools'
import { ToolDisplayNamesContext } from '../shared/ToolDisplayNames'
import { ToolResultAttachmentsContext } from '../shared/ToolDisplayNames'
import ToolHeader from '../ToolHeader'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../shared/GenericTools', async (importOriginal) => ({
  ...(await importOriginal<typeof GenericTools>()),
  ToolHeader: ({ toolName }: { toolName: string }) => <span>{toolName}</span>
}))

function Title({ name }: { name: string }) {
  return <>{UnknownToolRenderer({ toolName: name }).label}</>
}

describe('industrial-video tool display names', () => {
  it('renders the Chinese title and attachments through the generic MCP message branch', () => {
    const response = { content: [{ type: 'text', text: '{"ok":true,"jobId":"j"}' }] }
    const value: MessageListProviderValue = {
      state: {
        topic: { id: 'industrial-session', name: '工业视频' } as MessageListProviderValue['state']['topic'],
        messages: [],
        partsByMessageId: {},
        messageNavigation: 'none',
        estimateSize: 0,
        overscan: 0,
        loadOlderDelayMs: 0,
        loadingResetDelayMs: 0,
        renderConfig: defaultMessageRenderConfig
      },
      actions: {},
      meta: { selectionLayer: false }
    }
    render(
      <MessageListProvider value={value}>
        <ToolDisplayNamesContext value={INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES}>
          <ToolResultAttachmentsContext
            value={(name, output) =>
              name === 'mcp__meacowork-tools__ivideo_start' && output === response ? <span>消息内制作进度</span> : null
            }>
            <MessageMcpTool
              toolResponse={
                {
                  id: 'call',
                  status: 'done',
                  tool: { type: 'mcp', name: 'ivideo_start', serverId: 'cherry-tools', serverName: 'cherry-tools' },
                  response
                } as never
              }
            />
          </ToolResultAttachmentsContext>
        </ToolDisplayNamesContext>
      </MessageListProvider>
    )
    expect(screen.getByText('启动视频生成')).toBeTruthy()
    expect(screen.getByText('消息内制作进度')).toBeTruthy()
  })
  it('localizes the actual MCP header in industrial sessions', () => {
    render(
      <ToolDisplayNamesContext value={INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES}>
        <ToolHeader
          toolResponse={
            {
              tool: { type: 'mcp', name: 'ivideo_start', serverId: 'cherry-tools', serverName: 'cherry-tools' }
            } as never
          }
        />
      </ToolDisplayNamesContext>
    )
    expect(screen.getByText('启动视频生成')).toBeTruthy()
  })
  it('keeps the original MCP name without the industrial-video provider', () => {
    render(<Title name="mcp__cherry-tools__ivideo_status" />)
    expect(screen.getByText('cherry-tools:ivideo_status')).toBeTruthy()
  })

  it.each(Object.entries(INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES))(
    'renders the scoped Chinese title for %s',
    (name, label) => {
      render(
        <ToolDisplayNamesContext value={INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES}>
          <Title name={name} />
        </ToolDisplayNamesContext>
      )
      expect(screen.getByText(label)).toBeTruthy()
    }
  )

  it('does not rename other tools or unknown future industrial-video tools', () => {
    render(
      <ToolDisplayNamesContext value={INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES}>
        <Title name="mcp__other__ivideo_status" />
        <Title name="mcp__cherry-tools__ivideo_future" />
      </ToolDisplayNamesContext>
    )
    expect(screen.getByText('other:ivideo_status')).toBeTruthy()
    expect(screen.getByText('cherry-tools:ivideo_future')).toBeTruthy()
  })
})
