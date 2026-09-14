// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn()

vi.mock('@cherrystudio/ui', () => ({
  Scrollbar: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  )
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.toolbox.title': '工具箱',
        'workspace.toolbox.subtitle': '工具箱说明',
        'workspace.toolbox.products.hufu.name': '虎符',
        'workspace.toolbox.products.hufu.tagline': '虎符副标题',
        'workspace.toolbox.products.hufu.description': '虎符说明',
        'workspace.toolbox.products.gonggong.name': '共工',
        'workspace.toolbox.products.gonggong.tagline': '共工副标题',
        'workspace.toolbox.products.gonggong.description': '共工说明',
        'workspace.toolbox.products.suanpan.name': '算盘',
        'workspace.toolbox.products.suanpan.tagline': '算盘副标题',
        'workspace.toolbox.products.suanpan.description': '算盘说明',
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
        'workspace.toolbox.products.aiops.name': '运维',
        'workspace.toolbox.products.aiops.tagline': '运维副标题',
        'workspace.toolbox.products.aiops.description': '运维说明',
        'agent.channels.comingSoon': '即将推出'
      })[key] ?? key
  })
}))

import ToolboxPage from './ToolboxPage'

beforeEach(() => {
  ;(window as any).api = {
    shell: { openExternal }
  }
})

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

  it('opens an available product in the external browser', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    await user.click(screen.getByRole('button', { name: /虎符/ }))

    expect(openExternal).toHaveBeenCalledWith('http://osdev.xuelangyun.com:30080')
  })

  it('opens every product in the new roster with its own URL', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    for (const [name, url] of [
      [/共工/, 'http://osdev.xuelangyun.com:30080'],
      [/算盘/, 'http://osdev.xuelangyun.com:30080'],
      [/本体/, 'http://121.36.244.169:30009/?open_in_browser=true#/auth/login'],
      [/MDO/, 'http://mdo.xuelangyun.com/'],
      [/MetaM/, 'http://metam.xuelangyun.com/'],
      [/RTO/, 'http://rto.xuelangyun.com'],
      [/运维/, 'https://mro.xuelangyun.com/']
    ]) {
      openExternal.mockClear()
      await user.click(screen.getByRole('button', { name }))
      expect(openExternal).toHaveBeenCalledWith(url)
    }
  })
})
