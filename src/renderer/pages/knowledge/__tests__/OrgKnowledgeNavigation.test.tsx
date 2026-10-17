import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import type { OrgKnowledgeBase } from '@shared/data/types/enterpriseKnowledge'

import KnowledgePage from '../KnowledgePage'
import { KnowledgePageProvider, useKnowledgePage } from '../KnowledgePageProvider'
import KnowledgePageNavigatorSection from '../sections/KnowledgePageNavigatorSection'

vi.unmock('@cherrystudio/ui')
vi.mock('@renderer/components/FilePreview/plugins/pdf/PdfFilePreview', () => ({ default: () => null }))
// vi.mock('../sections/KnowledgePageDetailSection', () => ({ default: () => null }))
vi.mock('../sections/KnowledgePageDetailSection', () => ({
  default: function LocalDetail({ onSharingChange }: { onSharingChange?: (sharing: boolean) => void }) {
    const { selectedBase } = useKnowledgePage()
    const [sharing, setSharing] = useState(false)
    return (
      <div>
        {selectedBase?.name}本机详情
        <button
          type="button"
          onClick={() => {
            setSharing(true)
            onSharingChange?.(true)
          }}>
          打开本机分享码
        </button>
        {sharing ? (
          <div role="dialog">
            <button
              type="button"
              onClick={() => {
                setSharing(false)
                onSharingChange?.(false)
              }}>
              关闭本机分享码
            </button>
          </div>
        ) : null}
      </div>
    )
  }
}))
vi.mock('../components/ShareKnowledgeDialog', () => ({
  default: ({ baseId, mode }: { baseId: string; mode: string }) => <div role="dialog">{`${mode}:${baseId}`}</div>
}))
vi.mock('../sections/KnowledgePageDialogSection', () => ({ default: () => null }))
let capturedStatusHandler: (() => void) | undefined
const { request, local, catalog, refreshOrg, refetchLocal, updateBase, useIpcOn } = vi.hoisted(() => {
  const request = vi.fn()
  const refreshOrg = vi.fn()
  const refetchLocal = vi.fn()
  const updateBase = vi.fn()
  const useIpcOn = vi.fn((event: string, handler: () => void) => {
    if (event === 'enterprise.status_changed') capturedStatusHandler = handler
  })
  return {
    request,
    refreshOrg,
    refetchLocal,
    updateBase,
    useIpcOn,
    local: { bases: [] as KnowledgeBaseListItem[] },
    catalog: {
      public: [{ id: 'orgkb:public', name: '公共资料', description: '', documentCount: 1 }],
      shared: [{ id: 'orgkb:shared', name: '其他管理员分享', description: '', documentCount: 1 }],
      owned: [{ id: 'orgkb:owned', name: '我的服务端副本', description: '', documentCount: 1 }] as OrgKnowledgeBase[]
    }
  }
})
vi.mock('@renderer/hooks/useOrgKnowledge', () => ({
  useOrgKnowledge: () => ({ catalog, loading: false, error: null, refresh: refreshOrg })
}))
vi.mock('@renderer/hooks/useKnowledgeBase', () => ({
  useKnowledgeBases: () => ({ bases: local.bases, isLoading: false, refetch: refetchLocal }),
  useCreateKnowledgeBase: () => ({}),
  useRestoreKnowledgeBase: () => ({}),
  useUpdateKnowledgeBase: () => ({ updateBase, isUpdating: false }),
  useDeleteKnowledgeBase: () => ({})
}))
vi.mock('../hooks/useKnowledgeGroups', () => ({
  useKnowledgeGroups: () => ({ groups: [] }),
  useCreateKnowledgeGroup: () => ({}),
  useUpdateKnowledgeGroup: () => ({}),
  useDeleteKnowledgeGroup: () => ({})
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request }, useIpcOn }))
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  local.bases = []
  catalog.owned = [
    { id: 'orgkb:owned', name: '我的服务端副本', description: '', documentCount: 1, hasShareEvidence: true }
  ]
  request.mockReset()
  refreshOrg.mockReset().mockImplementation(async () => {
    catalog.owned = []
  })
  refetchLocal.mockReset().mockImplementation(async () => {
    local.bases = [{ id: 'local:restored', name: '恢复的本机库', groupId: null }] as KnowledgeBaseListItem[]
  })
  request.mockImplementation(async (route, input) => {
    if (route === 'enterprise.knowledge.items')
      return {
        items: [
          {
            id: 'item',
            baseId: input.baseId,
            title: `${input.baseId}云端资料.pdf`,
            type: 'file',
            parentId: null,
            status: 'ready',
            createdAt: '',
            updatedAt: ''
          }
        ],
        total: 1,
        nextCursor: null
      }
    if (route === 'enterprise.knowledge.shares') return { shares: [] }
    if (route === 'enterprise.knowledge.upload_status') return null
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared' }
    if (route === 'enterprise.knowledge.unshare_preview') return { restored: 1, missing: [] }
    if (route === 'enterprise.knowledge.unshare') return { ok: true }
    return { invitations: [], items: [], members: [], nextCursor: null }
  })
})

it('关闭失败的本地删除对话框后立即显示持久清理续作，失败可重试且成功才移除', async () => {
  local.bases = [{ id: 'local:original', name: '本机库', groupId: null }] as KnowledgeBaseListItem[]
  catalog.owned = [{ ...catalog.owned[0], localBaseId: 'local:original', shareCompleted: true }]
  let pending = false
  let cleanupAttempts = 0
  const original = request.getMockImplementation()!
  request.mockImplementation(async (route, input) => {
    if (route === 'enterprise.knowledge.pending_cleanup')
      return pending ? [{ baseId: 'orgkb:owned', localBaseId: 'restored-real' }] : []
    if (route === 'enterprise.knowledge.cleanup_local') {
      cleanupAttempts += 1
      if (cleanupAttempts === 1) {
        pending = true
        throw new Error('清理失败')
      }
      pending = false
      return { ok: true, localBaseId: 'restored-real' }
    }
    if (route === 'enterprise.knowledge.unshare') {
      pending = true
      throw new Error('清理失败')
    }
    return original(route, input)
  })
  render(<RoutedPage />)
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.more') }))
  await userEvent.click(await screen.findByRole('menuitem', { name: i18n.t('knowledge.context.delete') }))
  await userEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
  // 删除不再执行恢复预检，原恢复按钮步骤保留说明。
  // await userEvent.click(await screen.findByRole('button', { name: i18n.t('knowledge.org.recovery_prepare') }))
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.delete') }))
  expect(await screen.findByRole('alert')).toHaveTextContent('清理失败')
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }))
  const retry = await screen.findByRole('button', { name: /Continue local cleanup/ })
  await userEvent.click(retry)
  const retryAfterFailure = await screen.findByRole('button', { name: /Continue local cleanup/ })
  expect(retryAfterFailure).toBeInTheDocument()
  await userEvent.click(retryAfterFailure)
  await waitFor(() => expect(screen.queryByRole('button', { name: /Continue local cleanup/ })).not.toBeInTheDocument())
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.cleanup_local')).toEqual([
    ['enterprise.knowledge.cleanup_local', { baseId: 'orgkb:owned', localBaseId: 'restored-real' }],
    ['enterprise.knowledge.cleanup_local', { baseId: 'orgkb:owned', localBaseId: 'restored-real' }]
  ])
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.unshare')).toHaveLength(1)
})

function Selection() {
  const { selectedOrgBase, category } = useKnowledgePage()
  return <output>{`${category}:${selectedOrgBase?.id ?? ''}`}</output>
}

/* 旧分类断言保留；owned 现在仅属于本地。
it('无 localBaseId 的 owned 云端库在组织类别可见，切换本地时清除选择', async () => {
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
      <Selection />
    </KnowledgePageProvider>
  )
  expect(screen.queryByRole('region', { name: 'Knowledge bases I shared' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Shared with me' }))
  expect(screen.getByRole('button', { name: '我的服务端副本' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('shared:')
  await user.click(screen.getByRole('button', { name: 'Local' }))
  expect(screen.getByRole('status')).toHaveTextContent('local:')
})

it('本地库为空时仍可切换至 owned 云端入口', async () => {
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
    </KnowledgePageProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: 'Public' }))
  expect(screen.getByRole('button', { name: '我的服务端副本' })).toBeInTheDocument()
  expect(screen.queryByTestId('members')).not.toBeInTheDocument()
})

it('本地为空时仍可切换公共与分享类别，组织空态不出现创建操作', async () => {
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Public' }))
  expect(screen.getByRole('button', { name: '公共资料' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '公共资料' }))
  expect(screen.getByRole('button', { name: '公共资料' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('button', { name: /Create|Add/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Shared with me' }))
  expect(screen.getByRole('button', { name: '我的服务端副本' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add with share code' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Pending invitations/ })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
*/

function RoutedPage() {
  const [baseId, setBaseId] = useState<string>()
  return <KnowledgePage baseId={baseId} onBaseIdChange={setBaseId} />
}

it('首次分享目录刷新为 owned 后保留本机分享弹窗，主动关闭后进入云端详情', async () => {
  local.bases = [{ id: 'local:first', name: '首次分享库', groupId: null }] as KnowledgeBaseListItem[]
  catalog.owned = []
  const view = render(<RoutedPage />)
  await userEvent.click(await screen.findByRole('button', { name: '打开本机分享码' }))
  const dialog = screen.getByRole('dialog')
  catalog.owned = [
    { id: 'orgkb:first', localBaseId: 'local:first', name: '首次分享库', description: '', shareCompleted: true }
  ]
  view.rerender(<RoutedPage />)
  expect(screen.getByRole('dialog')).toBe(dialog)
  await userEvent.click(screen.getByRole('button', { name: '关闭本机分享码' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(await screen.findByText('orgkb:first云端资料.pdf')).toBeInTheDocument()
})

it('整页点击 A→B→A 时旧列表乱序返回不泄露甲库文件', async () => {
  let finishA!: (value: unknown) => void
  const original = request.getMockImplementation()!
  let first = true
  catalog.owned.push({ id: 'orgkb:B', name: '乙库', description: '' })
  request.mockImplementation((route, input) => {
    if (route === 'enterprise.knowledge.items' && input.baseId === 'orgkb:owned' && first) {
      first = false
      return new Promise((resolve) => {
        finishA = resolve
      })
    }
    return original(route, input)
  })
  render(<RoutedPage />)
  await userEvent.click(screen.getByRole('button', { name: '我的服务端副本' }))
  await userEvent.click(screen.getByRole('button', { name: '乙库' }))
  expect(await screen.findByText('orgkb:B云端资料.pdf')).toBeInTheDocument()
  await act(async () =>
    finishA({
      items: [{ id: 'secret', baseId: 'orgkb:owned', title: '甲库敏感文件', type: 'file', parentId: null }],
      total: 1,
      nextCursor: null
    })
  )
  expect(screen.queryByText('甲库敏感文件')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '乙库' })).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(screen.getByRole('button', { name: '我的服务端副本' }))
  expect(await screen.findByText('orgkb:owned云端资料.pdf')).toBeInTheDocument()
  expect(screen.queryByText('orgkb:B云端资料.pdf')).not.toBeInTheDocument()
})

it('旧取消分享回调及目录刷新晚完成不改变新库选择', async () => {
  let finish!: () => void
  refreshOrg.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  refetchLocal.mockResolvedValue(undefined)
  let stale!: () => void
  function Capture() {
    const value = useKnowledgePage()
    return (
      <>
        <Selection />
        <button
          type="button"
          onClick={() => {
            value.selectOrgBase(catalog.owned[0])
          }}>
          甲
        </button>
        <button
          type="button"
          onClick={() => {
            value.selectOrgBase(catalog.owned[1])
          }}>
          乙
        </button>
        <button
          type="button"
          onClick={() => {
            stale = value.handleOrgUnshared
          }}>
          捕获
        </button>
        <button type="button" onClick={() => value.handleOrgUnshared()}>
          完成
        </button>
      </>
    )
  }
  catalog.owned.push({ id: 'orgkb:B', name: '乙库', description: '' })
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <Capture />
    </KnowledgePageProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: '甲' }))
  await userEvent.click(screen.getByRole('button', { name: '捕获' }))
  await userEvent.click(screen.getByRole('button', { name: '完成' }))
  await userEvent.click(screen.getByRole('button', { name: '乙' }))
  await act(async () => finish())
  expect(screen.getByRole('status')).toHaveTextContent('local:orgkb:B')
  await act(async () => stale())
  expect(screen.getByRole('status')).toHaveTextContent('local:orgkb:B')
})

it('路由切换至同机关联库时详情和高亮一致，远端切换与晚完成操作不跳回旧库', async () => {
  local.bases = [
    { id: 'local:A', name: '本机甲库', groupId: null },
    { id: 'local:B', name: '同机乙库', groupId: null }
  ] as KnowledgeBaseListItem[]
  catalog.owned = [...catalog.owned, { id: 'orgkb:linked', localBaseId: 'local:B', name: '同机乙库', description: '' }]
  const { rerender } = render(<KnowledgePage baseId="local:A" onBaseIdChange={vi.fn()} />)
  expect(screen.getByText('本机甲库本机详情')).toBeInTheDocument()
  rerender(<KnowledgePage baseId="local:B" onBaseIdChange={vi.fn()} />)
  expect(await screen.findByText('orgkb:linked云端资料.pdf')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '我的服务端副本' }))
  expect(await screen.findByText('orgkb:owned云端资料.pdf')).toBeInTheDocument()
  expect(screen.queryByText('orgkb:linked云端资料.pdf')).not.toBeInTheDocument()
})

it('跨端 owned 仅在本地可见，点击加载云端资料并可管理', async () => {
  const user = userEvent.setup()
  render(<RoutedPage />)
  await user.click(screen.getByRole('button', { name: '我的服务端副本' }))
  expect(await screen.findByText('orgkb:owned云端资料.pdf')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.shares') }))
  expect(await screen.findByText('No share codes')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Generate share code' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Public' }))
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '公共资料' })).toBeInTheDocument()
  expect(screen.queryByText('orgkb:owned云端资料.pdf')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '公共资料' }))
  expect(await screen.findByText('orgkb:public云端资料.pdf')).toBeInTheDocument()
  expect(screen.queryByTestId('members')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Shared with me' }))
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '其他管理员分享' }))
  expect(await screen.findByText('orgkb:shared云端资料.pdf')).toBeInTheDocument()
  expect(screen.queryByTestId('members')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Local' }))
  expect(screen.queryByText('orgkb:shared云端资料.pdf')).not.toBeInTheDocument()
  expect(screen.queryByText('orgkb:owned云端资料.pdf')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '公共资料' })).not.toBeInTheDocument()
})

it('远端 owned 进入本地主滚动列表并显示云端标签，不再渲染 footer', async () => {
  render(<RoutedPage />)

  const remoteRow = screen.getByRole('button', { name: '我的服务端副本' })
  expect(remoteRow.closest('[data-knowledge-local-remote-rows]')).toBeInTheDocument()
  expect(remoteRow.parentElement).toHaveTextContent(i18n.t('knowledge.org.shared_tag'))
  expect(remoteRow.parentElement).not.toHaveTextContent(i18n.t('knowledge.org.cloud_tag'))
  expect(screen.queryByTestId('knowledge-local-remote-footer')).not.toBeInTheDocument()
})

it('无本机副本且可信完成的 owned 行显示已分享与云端标签', () => {
  catalog.owned = [{ ...catalog.owned[0], shareCompleted: true }]
  render(<RoutedPage />)

  const remoteRow = screen.getByRole('button', { name: '我的服务端副本' })
  expect(remoteRow.parentElement).toHaveTextContent(i18n.t('knowledge.org.shared_tag'))
})

it('远端选中有高亮，取消选择恢复 ghost', async () => {
  const user = userEvent.setup()
  render(<RoutedPage />)
  const row = screen.getByRole('button', { name: '我的服务端副本' })
  expect(row).toHaveAttribute('data-variant', 'ghost')
  await user.click(row)
  expect(row).toHaveAttribute('aria-pressed', 'true')
  expect(row.parentElement).toHaveClass('bg-muted')
  await user.click(screen.getByRole('button', { name: 'Public' }))
  await user.click(screen.getByRole('button', { name: 'Local' }))
  expect(screen.getByRole('button', { name: '我的服务端副本' })).toHaveAttribute('data-variant', 'ghost')
})

it('owned 无有效分享或证据未知仍可浏览，本机 pending 库去重保留原列表', async () => {
  catalog.owned = [
    { ...catalog.owned[0], hasShareEvidence: undefined, shareCompleted: false },
    { id: 'orgkb:pending', name: '远端未完成', description: null, shareCompleted: false, hasShareEvidence: false },
    {
      id: 'orgkb:local-pending',
      name: '本机关联副本',
      description: null,
      localBaseId: 'local:pending',
      shareCompleted: false
    }
  ]
  local.bases = [{ id: 'local:pending', name: '本机待完成', groupId: null }] as KnowledgeBaseListItem[]
  render(<RoutedPage />)
  expect(screen.getByRole('button', { name: '我的服务端副本' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '远端未完成' })).toBeInTheDocument()
  expect(screen.getByText('本机待完成')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '本机关联副本' })).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '我的服务端副本' }))
  expect(await screen.findByText('orgkb:owned云端资料.pdf')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '远端未完成' }))
  expect(await screen.findByText('orgkb:pending云端资料.pdf')).toBeInTheDocument()
})

it('本机完成关联仍可证已分享，无需远端查询成功', () => {
  catalog.owned = [{ ...catalog.owned[0], hasShareEvidence: undefined, shareCompleted: true }]
  render(<RoutedPage />)
  expect(screen.getByRole('button', { name: '我的服务端副本' }).parentElement).toHaveTextContent(
    i18n.t('knowledge.org.shared_tag')
  )
})

it('同机 owned 通过本机入口去重并打开云端，未分享本机仍正常选择', async () => {
  local.bases = [
    { id: 'local:shared', name: '本机已分享', groupId: null },
    { id: 'local:private', name: '本机私有', groupId: null }
  ] as KnowledgeBaseListItem[]
  catalog.owned = [{ ...catalog.owned[0], localBaseId: 'local:shared', shareCompleted: true }]
  const user = userEvent.setup()
  render(<RoutedPage />)
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  await user.click(screen.getByText('本机已分享'))
  expect(await screen.findByText('orgkb:owned云端资料.pdf')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Invite people' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('people:local:shared')
  await user.click(screen.getByText('本机私有'))
  expect(screen.getByText('本机私有本机详情')).toBeInTheDocument()
  expect(screen.queryByText('orgkb:owned云端资料.pdf')).not.toBeInTheDocument()
  expect(screen.queryByTestId('members')).not.toBeInTheDocument()
})

it.each([
  { localBaseId: 'local:shared', shareCompleted: true, allowed: true },
  { localBaseId: 'local:shared', shareCompleted: false, allowed: false },
  { localBaseId: undefined, shareCompleted: true, allowed: false }
])('云端详情仅可信同机完成库开放生成与指定人邀请：%j', async ({ localBaseId, shareCompleted, allowed }) => {
  catalog.owned = [{ ...catalog.owned[0], localBaseId, shareCompleted }]
  const user = userEvent.setup()
  render(<RoutedPage />)
  await user.click(screen.getByRole('button', { name: '我的服务端副本' }))
  if (allowed) {
    await user.click(screen.getByRole('button', { name: 'Invite people' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('people:local:shared')
  } else {
    expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument()
  }
  await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.shares') }))
  await screen.findByText('No share codes')
  expect(Boolean(screen.queryByRole('button', { name: 'Generate share code' }))).toBe(allowed)
  if (!allowed) expect(screen.getByText(i18n.t('knowledge.org.share_requires_local_completion'))).toBeInTheDocument()
})

it('跨端取消共享成功刷新组织与本机目录并显示恢复本机入口', async () => {
  const user = userEvent.setup()
  render(<RoutedPage />)
  await user.click(screen.getByRole('button', { name: '我的服务端副本' }))
  await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.shares') }))
  await user.click(await screen.findByRole('button', { name: 'Cancel sharing' }))
  await user.click(await screen.findByRole('button', { name: 'Restore and check local files' }))
  await user.click(await screen.findByRole('checkbox'))
  const confirm = screen.getByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  await waitFor(() => expect(refreshOrg).toHaveBeenCalledTimes(1))
  expect(refetchLocal).toHaveBeenCalledTimes(1)
  expect(await screen.findByText('恢复的本机库')).toBeInTheDocument()
  expect(screen.queryByText('orgkb:owned云端资料.pdf')).not.toBeInTheDocument()
  await user.click(screen.getByText('恢复的本机库'))
  expect(screen.getByText('恢复的本机库本机详情')).toBeInTheDocument()
})

it('切换分类清除云端选中，公共不会沿用 owned 选择', async () => {
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
      <Selection />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByRole('button', { name: '我的服务端副本' }))
  expect(screen.getByRole('status')).toHaveTextContent('local:orgkb:owned')
  await user.click(screen.getByRole('button', { name: 'Public' }))
  expect(screen.getByRole('status')).toHaveTextContent('public:')
  await user.click(screen.getByRole('button', { name: '公共资料' }))
  expect(screen.getByRole('status')).toHaveTextContent('public:orgkb:public')
  await user.click(screen.getByRole('button', { name: 'Local' }))
  expect(screen.getByRole('status')).toHaveTextContent('local:')
})

// === submitRenameBase × enterprise.knowledge.rename_shared 行为 ===
// 仅用于驱动 KnowledgePageProvider 的 submitRenameBase；对话框区在上方已被 mock 为空。
function RenameHarness() {
  const { openRenameBaseDialog, submitRenameBase } = useKnowledgePage()
  return (
    <>
      <button data-testid="open" onClick={() => openRenameBaseDialog({ id: 'local:shared', name: 'Old Name' })}>
        open
      </button>
      <button data-testid="open-remote" onClick={() => openRenameBaseDialog({ id: 'orgkb:owned', name: '旧名称' })}>
        open-remote
      </button>
      <button
        data-testid="rename-new"
        onClick={async () => {
          try {
            await submitRenameBase('New Name')
          } catch {
            // 本地失败会抛出，由对话框处理；本测试只关注是否触发云端请求
          }
        }}>
        rename-new
      </button>
    </>
  )
}

it('本地改名成功后对绑定本机库的共享副本发起云端重命名并刷新组织目录', async () => {
  catalog.owned = [
    {
      id: 'orgkb:owned',
      name: '我的服务端副本',
      description: '',
      documentCount: 1,
      localBaseId: 'local:shared',
      hasShareEvidence: true
    }
  ]
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.rename_shared', {
      baseId: 'orgkb:owned',
      name: 'New Name'
    })
  )
  expect(updateBase).toHaveBeenCalledWith('local:shared', { name: 'New Name' })
  expect(refreshOrg).toHaveBeenCalledTimes(1)
})

it('无本机副本的 owned 云端库可以直接发起云端重命名', async () => {
  catalog.owned = [
    { id: 'orgkb:owned', name: '我的服务端副本', description: '', documentCount: 1, hasShareEvidence: true }
  ]
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open-remote'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.rename_shared', {
      baseId: 'orgkb:owned',
      name: 'New Name'
    })
  )
  expect(updateBase).not.toHaveBeenCalled()
})

it('云端改名成功但目录刷新失败时仍关闭改名流程，不误报云端同步失败', async () => {
  catalog.owned = [
    { id: 'orgkb:owned', name: '我的服务端副本', description: '', documentCount: 1, hasShareEvidence: true }
  ]
  refreshOrg.mockRejectedValueOnce(new Error('refresh down'))
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open-remote'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.rename_shared', {
      baseId: 'orgkb:owned',
      name: 'New Name'
    })
  )
  await user.click(screen.getByTestId('rename-new'))
  expect(request).toHaveBeenCalledTimes(1)
})

it('云端重命名失败时保留弹窗不回滚本地，可再次保存并重新请求云端', async () => {
  catalog.owned = [
    {
      id: 'orgkb:owned',
      name: '我的服务端副本',
      description: '',
      documentCount: 1,
      localBaseId: 'local:shared',
      hasShareEvidence: true
    }
  ]
  request.mockImplementation(async (route: string) => {
    if (route === 'enterprise.knowledge.rename_shared') throw new Error('cloud down')
    return { invitations: [], items: [], members: [], nextCursor: null }
  })
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.rename_shared', {
      baseId: 'orgkb:owned',
      name: 'New Name'
    })
  )
  // 再次保存同一新名字：本地不回滚，云端请求再次发起（重试）。
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request).toHaveBeenNthCalledWith(2, 'enterprise.knowledge.rename_shared', {
    baseId: 'orgkb:owned',
    name: 'New Name'
  })
  // 本地改名被调用两次（首次成功，重试不回滚）。
  expect(updateBase).toHaveBeenCalledTimes(2)
})

it('本地改名失败时不发起云端重命名', async () => {
  catalog.owned = [
    {
      id: 'orgkb:owned',
      name: '我的服务端副本',
      description: '',
      documentCount: 1,
      localBaseId: 'local:shared',
      hasShareEvidence: true
    }
  ]
  updateBase.mockRejectedValueOnce(new Error('local down'))
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() => expect(updateBase).toHaveBeenCalledTimes(1))
  expect(request).not.toHaveBeenCalledWith('enterprise.knowledge.rename_shared', expect.anything())
})

it('本地改名过程中账号切换时不向云端写重命名，并关闭弹窗避免错误账号重试', async () => {
  catalog.owned = [
    {
      id: 'orgkb:owned',
      name: '我的服务端副本',
      description: '',
      documentCount: 1,
      localBaseId: 'local:shared',
      hasShareEvidence: true
    }
  ]
  let resolveUpdate!: () => void
  updateBase.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveUpdate = resolve
      })
  )
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <RenameHarness />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByTestId('open'))
  await user.click(screen.getByTestId('rename-new'))
  await waitFor(() => expect(updateBase).toHaveBeenCalledTimes(1))
  await act(async () => {
    capturedStatusHandler?.()
  })
  await act(async () => {
    resolveUpdate()
  })
  expect(updateBase).toHaveBeenCalledWith('local:shared', { name: 'New Name' })
  // 关键：账号已切换，绝不对任何云端账号发起 rename_shared。
  expect(request).not.toHaveBeenCalledWith('enterprise.knowledge.rename_shared', expect.anything())
  expect(refreshOrg).not.toHaveBeenCalled()
})
