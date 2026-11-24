// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { ExternalKnowledgeConnectorItem } from '@shared/ipc/schemas/enterprise'

import ExternalKnowledgeConnectorList from '../ExternalKnowledgeConnectorList'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const item: ExternalKnowledgeConnectorItem = {
  id: '11111111-1111-4111-8111-111111111111',
  resourceKey: 'test-reference',
  name: '企业资料',
  description: '共享资料',
  kind: 'weknora',
  serverId: null,
  isActive: false
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('外部知识库卡片', () => {
  it('默认关闭，手动启动等待结束后显示启用，手动停止不删除实例', async () => {
    let finish!: (value: unknown) => void
    const request = vi.spyOn(ipcApi, 'request').mockImplementation(async (route, input) => {
      if (route === 'enterprise.knowledge_connectors.list') return { connectors: [item] } as never
      const active = (input as { active: boolean }).active
      if (active)
        return await new Promise((resolve) => {
          finish = resolve
        })
      return { ...item, serverId: 'local-id', isActive: false } as never
    })
    render(<ExternalKnowledgeConnectorList visit={1} />)
    const control = await screen.findByRole('switch')
    expect(control).not.toBeChecked()
    const user = userEvent.setup()
    await user.click(control)
    expect(control).toBeDisabled()
    finish({ ...item, serverId: 'local-id', isActive: true })
    await waitFor(() => expect(control).toBeChecked())
    expect(control).not.toBeDisabled()
    await user.click(control)
    await waitFor(() => expect(control).not.toBeChecked())
    expect(screen.getByText('企业资料')).toBeVisible()
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      'enterprise.knowledge_connectors.list',
      'enterprise.knowledge_connectors.set_active',
      'enterprise.knowledge_connectors.set_active'
    ])
  })

  it('查询失败展示可重试错误，不显示成空目录；重新点击后能恢复', async () => {
    const request = vi.spyOn(ipcApi, 'request').mockRejectedValue(new Error('secret-response'))
    const { rerender } = render(<ExternalKnowledgeConnectorList visit={1} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.mcp.externalKnowledge.loadError')
    expect(screen.queryByText('settings.mcp.externalKnowledge.empty')).not.toBeInTheDocument()
    request.mockResolvedValue({ connectors: [item] })
    rerender(<ExternalKnowledgeConnectorList visit={2} />)
    expect(await screen.findByText('企业资料')).toBeVisible()
  })

  it('启动失败保持关闭，并仅展示本地化提示', async () => {
    vi.spyOn(ipcApi, 'request')
      .mockResolvedValueOnce({ connectors: [item] })
      .mockRejectedValue(new Error('secret-key'))
    render(<ExternalKnowledgeConnectorList visit={1} />)
    const control = await screen.findByRole('switch')
    await userEvent.click(control)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.mcp.externalKnowledge.operationError'))
    expect(control).not.toBeChecked()
    expect(document.body).not.toHaveTextContent('secret-key')
  })
})
