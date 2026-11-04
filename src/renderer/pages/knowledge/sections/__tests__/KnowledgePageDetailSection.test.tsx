import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { useKnowledgeUpload } from '../../components/KnowledgeUploadDetails'
import type ShareKnowledgeDialog from '../../components/ShareKnowledgeDialog'
import KnowledgePageDetailSection from '../KnowledgePageDetailSection'

vi.unmock('@cherrystudio/ui')
vi.mock('../../components/DetailHeader', () => ({
  default: ({ actions }: { actions: ReactNode }) => <header>{actions}</header>
}))

const { mockUseKnowledgeUpload, refreshCatalog } = vi.hoisted(() => ({
  mockUseKnowledgeUpload: vi.fn<typeof useKnowledgeUpload>(),
  refreshCatalog: vi.fn()
}))

vi.mock('../../components/KnowledgeUploadDetails', () => ({
  useKnowledgeUpload: mockUseKnowledgeUpload
}))

vi.mock('../../KnowledgePageProvider', () => ({
  useKnowledgePage: () => ({
    org: { catalog: { owned: [] }, refresh: refreshCatalog },
    orgSession: 'session',
    selectedBase: { id: 'local', name: '本地资料', status: 'completed' },
    selectedBaseId: 'local',
    baseNavigationVersion: 0
  })
}))

vi.mock('@renderer/hooks/useKnowledgeItems', () => ({
  useKnowledgeItems: () => ({
    items: [{ id: 'item', status: 'completed' }],
    total: 1,
    isLoading: false,
    hasMore: false,
    isLoadingMore: false
  }),
  useDeleteKnowledgeItem: () => ({}),
  useReindexKnowledgeItem: () => ({})
}))

vi.mock('../../hooks/useKnowledgeSyncStatus', () => ({
  useKnowledgeSyncStatus: () => ({ refresh: vi.fn() })
}))

// 只保留模式选择回调，菜单自身的开关和键盘行为不属于本测试。
vi.mock('@renderer/components/command', () => ({
  CommandPopupMenu: ({
    extraItems,
    disabled
  }: {
    children: ReactNode
    disabled?: boolean
    extraItems: { id: string; label: string; onSelect: () => void }[]
  }) => (
    <nav aria-label="分享方式">
      {extraItems.map((item) => (
        <button type="button" key={item.id} disabled={disabled} onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </nav>
  )
}))

vi.mock('@renderer/components/FilePreview', () => ({ FilePreview: () => null }))
vi.mock('../../panels/dataSource/DataSourcePanel', () => ({ default: () => null }))

// 弹窗只暴露组合边界，上传发起、关闭和恢复均由真实父组件协调。
vi.mock('../../components/ShareKnowledgeDialog', () => ({
  default: ({ mode, onUploadStarted, onClose }: ComponentProps<typeof ShareKnowledgeDialog>) => (
    <section role="dialog" aria-label={mode === 'people' ? '邀请成员' : '分享码'}>
      <button type="button" onClick={onUploadStarted}>
        开始上传
      </button>
      <button type="button" onClick={onClose}>
        关闭分享
      </button>
    </section>
  )
}))

const completedUpload: NonNullable<ReturnType<typeof useKnowledgeUpload>> = {
  phase: 'completed',
  totalBytes: 10,
  uploadedBytes: 10,
  totalFiles: 1,
  completedFiles: 1,
  currentFile: 'a.md',
  uploadOriginal: true,
  error: null
}

beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  mockUseKnowledgeUpload.mockReset().mockReturnValue(null)
  refreshCatalog.mockClear()
})

afterEach(cleanup)

it.each([
  { mode: 'people', action: 'Invite people', dialog: '邀请成员' },
  { mode: 'code', action: 'Share code', dialog: '分享码' }
])('$mode 上传后关闭仍保留宿主，跳过 uploading 的完成通知恢复原分享模式', async ({ action, dialog }) => {
  const user = userEvent.setup()
  const onSharingChange = vi.fn()
  const view = render(<KnowledgePageDetailSection onSharingChange={onSharingChange} />)
  expect(onSharingChange).toHaveBeenLastCalledWith(false)

  await user.click(within(screen.getByRole('navigation', { name: '分享方式' })).getByRole('button', { name: action }))
  const opened = screen.getByRole('dialog', { name: dialog })
  expect(onSharingChange).toHaveBeenLastCalledWith(true)

  await user.click(within(opened).getByRole('button', { name: '开始上传' }))
  await user.click(within(opened).getByRole('button', { name: '关闭分享' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onSharingChange).toHaveBeenLastCalledWith(true)

  // 轮询直接从 null 跳到 completed，不能依靠曾观察到 uploading 来恢复。
  mockUseKnowledgeUpload.mockReturnValue(completedUpload)
  view.rerender(<KnowledgePageDetailSection onSharingChange={onSharingChange} />)

  expect(refreshCatalog).toHaveBeenCalledOnce()
  if (dialog === '邀请成员') {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onSharingChange).toHaveBeenLastCalledWith(true)
    return
  }
  expect(await screen.findByRole('dialog', { name: dialog })).toBeInTheDocument()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.queryByRole('dialog', { name: dialog === '邀请成员' ? '分享码' : '邀请成员' })).not.toBeInTheDocument()
  expect(onSharingChange).toHaveBeenLastCalledWith(true)
})

it('没有新发起上传时，历史 completed 不自动打开分享弹窗', () => {
  mockUseKnowledgeUpload.mockReturnValue(completedUpload)
  const onSharingChange = vi.fn()
  const view = render(<KnowledgePageDetailSection onSharingChange={onSharingChange} />)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onSharingChange).toHaveBeenLastCalledWith(false)

  mockUseKnowledgeUpload.mockReturnValue({ ...completedUpload })
  view.rerender(<KnowledgePageDetailSection onSharingChange={onSharingChange} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onSharingChange).toHaveBeenLastCalledWith(false)
})
