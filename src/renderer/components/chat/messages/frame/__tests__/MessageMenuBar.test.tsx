import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Topic } from '@renderer/types/topic'

import { MessageListProvider } from '../../MessageListProvider'
import {
  defaultMessageMenuConfig,
  defaultMessageRenderConfig,
  type MessageListItem,
  type MessageListProviderValue
} from '../../types'

vi.mock('../MessageMenuBarToolbar', () => ({
  MessageMenuBarToolbarAction: ({
    action,
    menuActions,
    executeAction
  }: {
    action: { id: string }
    menuActions: Array<{ id: string; label: string }>
    executeAction: (action: unknown) => void
  }) => (
    <button
      className="message-action-button"
      type="button"
      onClick={() => {
        const usage = action.id === 'usage' ? action : menuActions.find(({ id }) => id === 'usage')
        if (usage) executeAction(usage)
      }}>
      {action.id}
    </button>
  )
}))

vi.mock('@renderer/utils/style', () => ({
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' ')
}))

vi.mock('@renderer/services/ExportService', () => ({
  exportService: {
    captureScrollableAsBlob: vi.fn(),
    captureScrollableAsDataUrl: vi.fn()
  },
  getMessageTitle: vi.fn(),
  messageToMarkdown: vi.fn()
}))

vi.mock('@renderer/utils/export', () => ({
  messageToPlainText: vi.fn()
}))

vi.mock('@renderer/utils/message/partsHelpers', () => ({
  canEditAssistantMessageParts: () => true,
  getTranslationFromParts: () => undefined,
  getTextFromParts: () => 'hello',
  hasTextParts: () => true,
  hasTranslationParts: () => false
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string, options?: { value?: string }) =>
      key === 'chat.message.token_details.tokens' ? `${options?.value} Tokens` : key,
    i18n: { resolvedLanguage: 'en-US' }
  })
}))

const { default: MessageMenuBar } = await import('../MessageMenuBar')

const topic = {
  id: 'topic-1',
  assistantId: 'assistant-1',
  name: 'Topic',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: []
} as Topic

const assistantMessage = {
  id: 'message-1',
  role: 'assistant',
  topicId: topic.id,
  parentId: 'message-0',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'success',
  stats: {
    inputTokens: 10,
    outputTokens: 32,
    totalTokens: 42
  }
} as MessageListItem

function renderWithProvider(
  children: ReactNode,
  renderConfig: Partial<typeof defaultMessageRenderConfig> = {},
  actionDisplayPolicy?: MessageListProviderValue['meta']['actionDisplayPolicy']
) {
  const value: MessageListProviderValue = {
    state: {
      topic,
      messages: [assistantMessage],
      partsByMessageId: {
        [assistantMessage.id]: []
      },
      hasOlder: false,
      messageNavigation: 'none',
      estimateSize: 0,
      overscan: 0,
      loadOlderDelayMs: 0,
      loadingResetDelayMs: 0,
      renderConfig: {
        ...defaultMessageRenderConfig,
        messageStyle: 'bubble',
        ...renderConfig
      },
      selection: {
        enabled: false,
        isMultiSelectMode: false,
        selectedMessageIds: []
      },
      menuConfig: defaultMessageMenuConfig,
      getMessageUiState: () => ({}),
      getMessageActivityState: () => ({
        isProcessing: false,
        isStreamTarget: false,
        isApprovalAnchor: false,
        isActiveTurnProcessing: false,
        isStreamLive: false
      }),
      translationLanguages: []
    },
    actions: {
      copyText: vi.fn(),
      locateMessage: vi.fn()
    },
    meta: {
      actionDisplayPolicy,
      selectionLayer: false
    }
  }

  return render(<MessageListProvider value={value}>{children}</MessageListProvider>)
}

describe('MessageMenuBar', () => {
  it('不显示底部 tokens 和更多，并可从平铺按钮打开原用量详情', () => {
    const { container } = renderWithProvider(
      <MessageMenuBar
        message={assistantMessage}
        isLastMessage
        isAssistantMessage
        isProcessing={false}
        messageContainerRef={{ current: null } as unknown as React.RefObject<HTMLDivElement>}
      />,
      {},
      { toolbar: ['copy', 'delete', 'usage'], menu: [], collapseUsage: true, usageLabel: '查看用量' }
    )
    expect(container.querySelector('.message-tokens')).toBeNull()
    expect(screen.queryByRole('button', { name: 'more-menu' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'usage' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('查看用量')
    expect(screen.getByRole('dialog')).toHaveTextContent('10 Tokens')
    expect(screen.getByRole('dialog')).toHaveTextContent('32 Tokens')
  })

  it('shows assistant token usage in the bubble footer toolbar regardless of the estimated-tokens setting', () => {
    const { container } = renderWithProvider(
      <MessageMenuBar
        message={assistantMessage}
        isLastMessage
        isAssistantMessage
        isProcessing={false}
        messageContainerRef={{ current: null } as unknown as React.RefObject<HTMLDivElement>}
      />,
      { showEstimatedTokens: false }
    )

    expect(container.querySelector('.message-tokens')).toHaveTextContent('42 Tokens')
  })
})
