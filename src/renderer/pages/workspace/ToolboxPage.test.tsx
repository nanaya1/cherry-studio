// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openSmartMiniApp = vi.fn()

vi.mock('@cherrystudio/ui', () => ({
  Scrollbar: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  )
}))

vi.mock('@renderer/hooks/useMiniAppPopup', () => ({
  useMiniAppPopup: () => ({ openSmartMiniApp })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.toolbox.title': '工具箱',
        'workspace.toolbox.subtitle': '工具箱说明',
        'workspace.toolbox.products.mdo.name': 'MDO',
        'workspace.toolbox.products.mdo.tagline': 'MDO 副标题',
        'workspace.toolbox.products.mdo.description': 'MDO 说明',
        'workspace.toolbox.products.metam.name': 'MetaM',
        'workspace.toolbox.products.metam.tagline': 'MetaM 副标题',
        'workspace.toolbox.products.metam.description': 'MetaM 说明',
        'workspace.toolbox.products.rto.name': 'RTO',
        'workspace.toolbox.products.rto.tagline': 'RTO 副标题',
        'workspace.toolbox.products.rto.description': 'RTO 说明',
        'workspace.toolbox.products.ontology.name': '本体',
        'workspace.toolbox.products.ontology.tagline': '本体副标题',
        'workspace.toolbox.products.ontology.description': '本体说明',
        'workspace.toolbox.products.tuling.name': '图零',
        'workspace.toolbox.products.tuling.tagline': '图零副标题',
        'workspace.toolbox.products.tuling.description': '图零说明',
        'workspace.toolbox.products.productionControl.name': '生产管控',
        'workspace.toolbox.products.productionControl.tagline': '生产管控副标题',
        'workspace.toolbox.products.productionControl.description': '生产管控说明',
        'workspace.toolbox.products.pro.name': 'PRO',
        'workspace.toolbox.products.pro.tagline': 'PRO 副标题',
        'workspace.toolbox.products.pro.description': 'PRO 说明',
        'workspace.toolbox.products.aiops.name': '智能运维',
        'workspace.toolbox.products.aiops.tagline': '智能运维副标题',
        'workspace.toolbox.products.aiops.description': '智能运维说明',
        'agent.channels.comingSoon': '即将推出'
      })[key] ?? key
  })
}))

import ToolboxPage from './ToolboxPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ToolboxPage', () => {
  it('renders the product grid with the same page hierarchy as other workspace catalogs', () => {
    render(<ToolboxPage />)

    expect(screen.getAllByRole('heading', { name: '工具箱' })).toHaveLength(1)
    expect(screen.getByRole('list')).toBeVisible()
    expect(screen.getAllByRole('button')).toHaveLength(8)
    expect(screen.queryByText('8')).not.toBeInTheDocument()
  })

  it('opens an available product in the built-in mini app', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    await user.click(screen.getByRole('button', { name: /图零/ }))

    expect(openSmartMiniApp).toHaveBeenCalledWith({
      appId: 'toolbox-tuling',
      name: '图零',
      url: 'https://tl.xuelangyun.com/'
    })
  })

  it('keeps products without a URL disabled and marks them as coming soon', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    const proCard = screen.getByRole('button', { name: /PRO/ })
    expect(proCard).toBeDisabled()
    expect(proCard).toHaveTextContent('即将推出')

    await user.click(proCard)
    expect(openSmartMiniApp).not.toHaveBeenCalled()
  })
})
