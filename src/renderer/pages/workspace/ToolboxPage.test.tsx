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
      (key.match(/^workspace\.toolbox\.products\.(hufu|gonggong|suanpan)\./)
        ? zhCN[key as keyof typeof zhCN]
        : undefined) ??
      {
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
      }[key] ??
      key
  })
}))

import zhCN from '../../i18n/locales/zh-cn.json'
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

  it.each([
    [
      '系统工程',
      '工业混合建模与联合计算系统',
      '沉淀标准化业务组件与行业模板、可视化拖拽搭建、将专家经验转化为企业数字资产'
    ],
    [
      '雪浪虎符',
      '工业数据要素与语料资产平台',
      '构建企业级工业数据资产与要素化平台,打通产品研发、设备运行、生产经营中的多源异构数据，统一开展数据治理,实现工业数据的资产化、要素化、语料化，为智能化应用提供可信的数据要素支撑。'
    ],
    ['AI应用搭建', 'AI应用搭建平台', '以对话定义业务，AI 生成资产，可视化组装，快速交付可用 AI 应用']
  ])('shows the supplied product name, subtitle and description for %s', (name, tagline, description) => {
    render(<ToolboxPage />)

    expect(screen.getByRole('button', { name: new RegExp(name) })).toBeEnabled()
    expect(screen.getByText(name)).toBeVisible()
    expect(screen.getByText(tagline)).toBeVisible()
    expect(screen.getByText(description)).toBeVisible()
  })

  it('opens an available product in the external browser', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    await user.click(screen.getByRole('button', { name: /虎符/ }))

    expect(openExternal).toHaveBeenCalledWith('https://xlos.xuelangyun.com/web/hufu/0')
  })

  it('opens every product in the new roster with its own URL', async () => {
    const user = userEvent.setup()
    render(<ToolboxPage />)

    for (const [name, url] of [
      [/AI应用搭建/, 'http://10.88.36.191:19090/hermes/'],
      [/系统工程/, 'https://xlos.xuelangyun.com/web/service/predict'],
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
