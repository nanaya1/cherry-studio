import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'
import { ResourceList } from '@renderer/components/chat/resourceList/base'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import SessionItem, { type SessionItemMenuActions } from '../SessionItem'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())

vi.mock('@renderer/components/chat/actions/ResourceListActionContextMenu', () => ({
  ResourceListActionContextMenu: ({ children }: { children: ReactNode }) => children
}))

vi.mock('@renderer/components/chat/panes/Shell', () => ({
  useOptionalRightPanelActions: () => undefined,
  useOptionalRightPanelState: () => undefined
}))

vi.mock('@renderer/data/hooks/useCache', () => ({
  useCache: () => [[]]
}))

vi.mock('@renderer/hooks/useTopicStreamStatus', () => ({
  useTopicStreamStatus: () => ({
    status: undefined,
    awaitingApprovalAnchors: [],
    isFulfilled: false,
    isPending: false,
    markSeen: vi.fn()
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'industrial_video.title': 'Industrial video',
        'common.cancel': 'Cancel',
        'common.archive': 'Archive',
        'recycle_bin.move.confirm_action': 'Move to Recycle Bin',
        'recycle_bin.move.confirm_title': 'Move to Recycle Bin?'
      })[key] ?? key
  })
}))

const session: AgentSessionEntity = {
  id: 'session-a',
  agentId: 'agent-a',
  name: 'Session A',
  isNameManuallyEdited: true,
  workspaceId: 'workspace-a',
  workspace: {
    id: 'workspace-a',
    name: 'Workspace A',
    path: '/workspace-a',
    type: 'user',
    orderKey: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  orderKey: 'a',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const sessionMenuActions = Object.fromEntries(
  [
    'onAutoRename',
    'onCopyImage',
    'onCopyMarkdown',
    'onCopyPlainText',
    'onExportImage',
    'onExportJoplin',
    'onExportMarkdown',
    'onExportMarkdownReason',
    'onExportNotion',
    'onExportObsidian',
    'onExportSiyuan',
    'onExportWord',
    'onExportYuque',
    'onSaveToKnowledge',
    'onSaveToNotes'
  ].map((name) => [name, vi.fn()])
) as unknown as SessionItemMenuActions
sessionMenuActions.exportMenuOptions = {
  docx: false,
  image: false,
  joplin: false,
  markdown: false,
  markdown_reason: false,
  notion: false,
  obsidian: false,
  plain_text: false,
  siyuan: false,
  yuque: false
}

describe('SessionItem', () => {
  it('identifies video tasks even when the sidebar hides ordinary leading icons', () => {
    const video = { ...session, featureKind: 'industrial-video' as const }
    const Provider = ResourceList.Provider<AgentSessionEntity>
    render(
      <Provider items={[video]}>
        <SessionItem
          session={video}
          reserveLeadingIconSlot={false}
          sessionMenuActions={sessionMenuActions}
          onDelete={vi.fn()}
          onOpenRenameDialog={vi.fn()}
          onPress={vi.fn()}
        />
      </Provider>
    )
    expect(screen.getByRole('img', { name: 'Industrial video' })).toBeInTheDocument()
  })

  it('archives through the hover action without requesting permanent deletion', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const Provider = ResourceList.Provider<AgentSessionEntity>

    render(
      <Provider items={[session]} selectedId={session.id}>
        <SessionItem
          session={session}
          sessionMenuActions={sessionMenuActions}
          onDelete={onDelete}
          onOpenRenameDialog={vi.fn()}
          onPress={vi.fn()}
        />
      </Provider>
    )

    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(onDelete).toHaveBeenCalledWith('session-a')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
