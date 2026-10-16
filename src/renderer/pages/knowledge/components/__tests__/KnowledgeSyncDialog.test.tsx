import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import KnowledgeSyncDialog from '../KnowledgeSyncDialog'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  listener: undefined as ((value: any) => void) | undefined,
  change: undefined as (() => void) | undefined
}))
vi.mock('@data/hooks/useDataApi', () => ({
  useDataChange: (_endpoints: unknown, listener: () => void) => {
    mocks.change = listener
  }
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request },
  useIpcOn: (_event: string, listener: (value: any) => void) => {
    mocks.listener = listener
  }
}))
vi.unmock('@cherrystudio/ui')
const preview = {
  baseId: 'local',
  shareId: 'orgkb:copy',
  planId: 'plan-1',
  status: 'pending',
  changes: ['add', 'update', 'rename', 'delete'].map((kind) => ({
    itemId: kind,
    fileName: `${kind}.md`,
    kind,
    remoteFileId: null
  })),
  warnings: ['服务端警告']
}
const props = { baseId: 'local', name: '资料', onClose: vi.fn(), onSynced: vi.fn() }
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  vi.clearAllMocks()
  mocks.request.mockImplementation(async (route) => {
    if (route === 'enterprise.status.get') return { generation: 1, phase: 'signed-in' }
    if (route === 'enterprise.knowledge.sync_preview') return preview
    return {
      status: 'partial',
      shareId: 'orgkb:copy',
      files: [
        { itemId: 'add', fileName: 'add.md', kind: 'add', status: 'success', error: null },
        { itemId: 'update', fileName: 'update.md', kind: 'update', status: 'failure', error: '失败原因' },
        { itemId: 'delete', fileName: 'delete.md', kind: 'delete', status: 'unknown', error: null }
      ]
    }
  })
})

it('预览四类差异和警告，明确勾选删除才执行，并保留逐文件结果且不重试未知项', async () => {
  const user = userEvent.setup()
  render(<KnowledgeSyncDialog {...props} />)
  await screen.findByText('服务端警告')
  for (const kind of ['add', 'update', 'rename', 'delete']) expect(screen.getByText(`${kind}.md`)).toBeInTheDocument()
  const apply = screen.getByRole('button', { name: 'Apply sync' })
  expect(apply).toBeDisabled()
  await user.click(screen.getByRole('checkbox'))
  await user.click(apply)
  expect(await screen.findByText('失败原因', { exact: false })).toBeInTheDocument()
  expect(screen.getByText('Result unknown')).toBeInTheDocument()
  expect(mocks.request).toHaveBeenCalledWith('enterprise.knowledge.sync_apply', {
    baseId: 'local',
    planId: 'plan-1',
    confirmDeletes: true
  })
  expect(screen.queryByRole('button', { name: 'Apply sync' })).not.toBeInTheDocument()
  expect(mocks.request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.sync_apply')).toHaveLength(1)
})

it.each(['incomplete', 'unconfirmed', 'unknown'])('%s 副本不可执行且解释恢复限制', async (status) => {
  mocks.request.mockImplementation(async (route) =>
    route === 'enterprise.status.get' ? { generation: 1, phase: 'signed-in' } : { ...preview, status }
  )
  render(<KnowledgeSyncDialog {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Verify the sharing records')
  expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled()
})

it('源变化错误消耗计划，必须重新预览并重新确认删除', async () => {
  const user = userEvent.setup()
  mocks.request.mockImplementation(async (route) => {
    if (route === 'enterprise.status.get') return { generation: 1, phase: 'signed-in' }
    if (route === 'enterprise.knowledge.sync_apply') throw new Error('本地内容已变化')
    return preview
  })
  render(<KnowledgeSyncDialog {...props} />)
  await screen.findByText('服务端警告')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Apply sync' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('本地内容已变化')
  expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Preview again' }))
  await screen.findByText('服务端警告')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})

it('本地变更通知使已确认的预览立即失效', async () => {
  const user = userEvent.setup()
  render(<KnowledgeSyncDialog {...props} />)
  await screen.findByText('服务端警告')
  await user.click(screen.getByRole('checkbox'))
  act(() => mocks.change?.())
  expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled()
  expect(screen.queryByText('服务端警告')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Local data changed')
})

it('账号 generation 变化清空预览，丢弃迟到的执行结果', async () => {
  let resolve!: (value: unknown) => void
  const user = userEvent.setup()
  render(<KnowledgeSyncDialog {...props} />)
  await screen.findByText('服务端警告')
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Apply sync' }))
  act(() => mocks.listener?.({ generation: 2, phase: 'signed-out' }))
  await act(async () => resolve({ status: 'complete', files: [], shareId: 'orgkb:old' }))
  expect(screen.queryByText('服务端警告')).not.toBeInTheDocument()
  expect(props.onSynced).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled()
})
