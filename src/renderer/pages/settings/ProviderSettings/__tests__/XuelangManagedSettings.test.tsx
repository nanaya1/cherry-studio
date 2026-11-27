import { mockUseMutation, mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createUniqueModelId, ENDPOINT_TYPE, type Model } from '@shared/data/types/model'
import type { ApiKeyEntry, Provider } from '@shared/data/types/provider'

import XuelangManagedSettings from '../ProviderSpecific/XuelangManagedSettings'

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({ list, children, getItemKey }: any) => (
    <div>
      {list.map((item: unknown, index: number) => (
        <div key={getItemKey(index)}>{children(item)}</div>
      ))}
    </div>
  )
}))

vi.mock('../primitives/ProviderSettingsDrawer', () => ({
  default: ({
    children,
    footer,
    open,
    onClose
  }: {
    children: ReactNode
    footer: ReactNode
    open: boolean
    onClose: () => void
  }) =>
    open ? (
      <div
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}>
        {children}
        {footer}
      </div>
    ) : null
}))

const provider: Provider = {
  id: 'xuelang',
  name: '雪浪工匠',
  authType: 'api-key',
  isEnabled: true,
  hasManagedSnapshot: true,
  apiKeys: [],
  settings: {},
  reportsActualCost: false
}
const chat = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
const responses = ENDPOINT_TYPE.OPENAI_RESPONSES
const chatModel: Model = {
  id: createUniqueModelId('xuelang', 'chat-id'),
  providerId: 'xuelang',
  apiModelId: 'gateway/chat',
  name: 'Chat',
  endpointTypes: [chat],
  isEnabled: true,
  isHidden: false,
  capabilities: [],
  supportsStreaming: true
}
const responsesModel: Model = {
  ...chatModel,
  id: createUniqueModelId('xuelang', 'responses-id'),
  name: 'Responses',
  endpointTypes: [responses],
  isEnabled: false
}

const baseUrl = 'https://gateway.example.test/v1'
const managedKey: ApiKeyEntry = {
  id: 'managed-key',
  label: 'Cowork',
  key: 'sk****abcd',
  isEnabled: true,
  managedRoutes: {
    endpointConfigs: { [chat]: { baseUrl } },
    models: [{ id: 'gateway/chat', endpointTypes: [chat] }]
  }
}
const trigger = vi.fn()

function setSettingsData(keys: (ApiKeyEntry & { revoked?: boolean })[], models: Model[]) {
  mockUseQuery.mockImplementation((path) => ({
    data: (String(path) === '/models' ? models : String(path).endsWith('/api-keys') ? { keys } : undefined) as never,
    isLoading: false,
    isRefreshing: false,
    refetch: vi.fn(),
    mutate: vi.fn()
  }))
}

function modelRow(name: string) {
  return within(screen.getByRole('switch', { name }).closest('[data-model-row]')!)
}

const noUsableKey = /No usable API key|无可用 API Key/

describe('企业雪浪工匠设置', () => {
  beforeEach(() => {
    trigger.mockReset().mockResolvedValue(undefined)
    mockUseMutation.mockImplementation((method, path) => ({
      trigger: (args) => trigger(method, path, args),
      isLoading: false,
      error: undefined
    }))
  })

  it('只发送单条开关 PATCH，不提供明文、复制或配置编辑入口', async () => {
    setSettingsData(
      [managedKey, { id: 'legacy', key: 'unexpected-secret', isEnabled: false }],
      [chatModel, responsesModel]
    )
    render(<XuelangManagedSettings provider={provider} />)
    const user = userEvent.setup()
    const maskedKey = screen.getByText('sk****abcd')

    expect(fireEvent.copy(maskedKey)).toBe(false)
    expect(screen.queryByText('unexpected-secret')).not.toBeInTheDocument()
    expect(screen.getByText(baseUrl)).toBeInTheDocument()
    const entry = screen.getAllByRole('button', {
      name: /api key management|api 密钥管理|settings\.provider\.api\.key\.list\.title/i
    })[0]
    expect(entry).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /copy|edit|delete|remove|add|sync|refresh|复制|编辑|删除|新增|同步|刷新/i })
    ).not.toBeInTheDocument()
    expect(modelRow('Chat').queryByText(noUsableKey)).not.toBeInTheDocument()
    expect(modelRow('Responses').getByText(noUsableKey)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Responses' })).not.toBeChecked()

    await user.click(entry)
    const drawer = within(await screen.findByRole('dialog'))
    expect(drawer.getByText(new RegExp(`${chat}.*${baseUrl}`))).toBeInTheDocument()
    expect(drawer.queryByText('unexpected-secret')).not.toBeInTheDocument()
    expect(
      drawer.queryByRole('button', { name: /copy|edit|delete|remove|add|复制|编辑|删除|新增/i })
    ).not.toBeInTheDocument()
    await user.click(drawer.getByRole('switch', { name: 'Cowork 1' }))
    await user.keyboard('{Escape}')
    await user.click(await screen.findByRole('switch', { name: 'Responses' }))

    expect(trigger.mock.calls).toEqual([
      [
        'PATCH',
        '/providers/:providerId/api-keys/:keyId',
        { params: { providerId: 'xuelang', keyId: 'managed-key' }, body: { isEnabled: false } }
      ],
      [
        'PATCH',
        '/models/:uniqueModelId*',
        { params: { uniqueModelId: 'xuelang::responses-id' }, body: { isEnabled: true } }
      ]
    ])
  })

  it('相同地址只显示一次，不同地址打开同一个密钥抽屉查看协议和地址', async () => {
    const secondUrl = 'https://gateway.example.test/tenant/responses'
    const secondKey = {
      ...managedKey,
      id: 'second-key',
      isEnabled: false,
      managedRoutes: { endpointConfigs: { [responses]: { baseUrl } }, models: [] }
    }
    setSettingsData([managedKey, secondKey], [])
    const { rerender } = render(<XuelangManagedSettings provider={provider} />)
    expect(screen.getByText(baseUrl)).toBeInTheDocument()

    setSettingsData(
      [
        managedKey,
        {
          ...secondKey,
          managedRoutes: { ...secondKey.managedRoutes, endpointConfigs: { [responses]: { baseUrl: secondUrl } } }
        }
      ],
      []
    )
    rerender(<XuelangManagedSettings provider={provider} />)

    const addressEntry = screen.getByRole('button', { name: /Multiple API addresses|多个 API 地址/ })
    const keyEntry = screen.getAllByRole('button', { name: /API Key Management|API 密钥管理/i })[0]
    expect(screen.queryByText(baseUrl)).not.toBeInTheDocument()
    expect(screen.queryByText(secondUrl)).not.toBeInTheDocument()
    expect(keyEntry).toHaveAttribute('aria-expanded', 'false')

    await userEvent.setup().click(addressEntry)
    const drawer = within(await screen.findByRole('dialog'))
    expect(keyEntry).toHaveAttribute('aria-expanded', 'true')
    expect(drawer.getByText(new RegExp(`${chat}.*${baseUrl}`))).toBeInTheDocument()
    expect(drawer.getByText(new RegExp(`${responses}.*${secondUrl}`))).toBeInTheDocument()
    expect(drawer.getByRole('switch', { name: 'Cowork 2' })).not.toBeChecked()
    expect(trigger).not.toHaveBeenCalled()
  })

  it('撤权 Key 和模型不显示，剩余 Key 停用时不改变模型开关意愿', () => {
    setSettingsData(
      [
        {
          ...managedKey,
          revoked: true,
          managedRoutes: { endpointConfigs: { [chat]: { baseUrl: 'https://revoked.example.test' } }, models: [] }
        },
        { ...managedKey, id: 'disabled', label: 'Disabled', isEnabled: false }
      ],
      [chatModel, { ...responsesModel, isDeprecated: true }]
    )
    render(<XuelangManagedSettings provider={provider} />)

    expect(screen.getByText(baseUrl)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Cowork 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Responses' })).not.toBeInTheDocument()
    expect(modelRow('Chat').getByText(noUsableKey)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Chat' })).toBeChecked()
  })

  it('没有当前身份快照时不显示仍留在查询缓存里的 Key 或模型', () => {
    setSettingsData([managedKey], [chatModel])
    render(<XuelangManagedSettings provider={{ ...provider, hasManagedSnapshot: false }} />)

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('sk****abcd')).not.toBeInTheDocument()
    expect(screen.queryByText(baseUrl, { exact: false })).not.toBeInTheDocument()
  })

  it('区分企业同步失败和空目录，不提供手动刷新', () => {
    setSettingsData([], [])
    render(<XuelangManagedSettings provider={{ ...provider, managedSyncState: 'failed' }} />)

    expect(screen.getByText(/Could not sync organization model settings|企业模型配置同步失败/)).toBeInTheDocument()
    expect(screen.getByText(/has not assigned any API keys|尚未为你下发 API 密钥/)).toBeInTheDocument()
    expect(screen.getByText(/has not assigned any models|当前账号暂无可用模型/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /copy|edit|delete|remove|add|sync|refresh|复制|编辑|删除|新增|同步|刷新/i })
    ).not.toBeInTheDocument()
  })
})
