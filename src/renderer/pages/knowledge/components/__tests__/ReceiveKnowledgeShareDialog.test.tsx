import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import ReceiveKnowledgeShareDialog from '../ReceiveKnowledgeShareDialog'

const { request, status } = vi.hoisted(() => ({
  request: vi.fn(),
  status: { listener: undefined as undefined | ((value: { generation: number; phase: string }) => void) }
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request },
  useIpcOn: (_: string, listener: typeof status.listener) => {
    status.listener = listener
  }
}))
vi.unmock('@cherrystudio/ui')
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  request.mockReset()
})

it('校验纯码并保留大小写，服务错误保留输入，成功后的目录失败不显示领取失败', async () => {
  const user = userEvent.setup()
  let attempt = 0
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.status.get') return { generation: 1, phase: 'signed-in' }
    if (++attempt === 1) throw new Error('密码错误')
    return { baseId: 'orgkb:received', name: '资料' }
  })
  const received = vi.fn(async () => {
    throw new Error('catalog delayed')
  })
  render(<ReceiveKnowledgeShareDialog onClose={vi.fn()} onReceived={received} />)
  const code = screen.getByLabelText('Share code')
  await user.type(code, 'abc')
  expect(screen.getByRole('button', { name: 'Add knowledge base' })).toBeDisabled()
  await user.clear(code)
  await user.type(code, 'Abcd_123')
  await user.type(screen.getByLabelText('Extraction password (optional, 4–32 characters)'), 'abcd')
  await user.click(screen.getByRole('button', { name: 'Add knowledge base' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('密码错误')
  expect(code).toHaveValue('Abcd_123')
  await user.click(screen.getByRole('button', { name: 'Add knowledge base' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Added.')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.receive_share', {
    shareCode: 'Abcd_123',
    password: 'abcd'
  })
  expect(received).toHaveBeenCalledWith({ baseId: 'orgkb:received', name: '资料' })
})

it('generation 变化清除密码并丢弃旧领取回包', async () => {
  const user = userEvent.setup()
  let resolve!: (value: unknown) => void
  request.mockImplementation((route) =>
    route === 'enterprise.status.get'
      ? Promise.resolve({ generation: 1, phase: 'signed-in' })
      : new Promise((done) => {
          resolve = done
        })
  )
  const received = vi.fn()
  render(<ReceiveKnowledgeShareDialog onClose={vi.fn()} onReceived={received} />)
  await user.type(screen.getByLabelText('Share code'), 'Abcd_123')
  const password = screen.getByLabelText('Extraction password (optional, 4–32 characters)')
  await user.type(password, 'abcd')
  await user.click(screen.getByRole('button', { name: 'Add knowledge base' }))
  act(() => status.listener?.({ generation: 2, phase: 'signed-in' }))
  expect(password).toHaveValue('')
  await act(async () => resolve({ baseId: 'orgkb:old', name: '旧资料' }))
  expect(received).not.toHaveBeenCalled()
  expect(screen.queryByText(/Added\./)).not.toBeInTheDocument()
})
