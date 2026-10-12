import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { useMiniAppLogoMock } = vi.hoisted(() => ({ useMiniAppLogoMock: vi.fn(() => undefined as unknown) }))

vi.mock('@cherrystudio/ui', () => ({
  Avatar: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  AvatarImage: (props: Record<string, unknown>) => <img {...props} />,
  AvatarFallback: ({ children, ...props }: { children: ReactNode }) => <span {...props}>{children}</span>
}))

vi.mock('@renderer/components/icons/miniAppsLogo', () => ({
  getMiniAppsLogoRef: (icon?: string) => (icon?.startsWith('miniapps:') ? { id: 'test' } : undefined),
  useMiniAppLogo: useMiniAppLogoMock
}))

import { TabIcon } from '../TabIcon'

afterEach(cleanup)

// MEA:resource-icons 隐藏实体头像，同时保留路由、浏览器及小程序图标行为。
describe('MEA resource-icons: tab icons', () => {
  it.each([
    ['/app/chat', 'lucide-message-circle'],
    ['/app/agents/agent-1', 'lucide-mouse-pointer-click']
  ])('实体头像回退到 %s 的路由图标', (url, iconClass) => {
    const { container } = render(
      <TabIcon tab={{ id: 't1', type: 'route', url, title: 'Tab', icon: 'emoji:🤖' }} size={20} className="tab-icon" />
    )

    expect(screen.queryByText('🤖')).not.toBeInTheDocument()
    expect(container.querySelector(`svg.${iconClass}`)).toHaveAttribute('width', '20')
    expect(container.querySelector(`svg.${iconClass}`)).toHaveClass('tab-icon')
  })

  it.each(['/app/browser', '/app/browser?url=example'])('浏览器 %s 保留图片及 Globe 回退', (url) => {
    const { container } = render(
      <TabIcon tab={{ id: 't1', type: 'route', url, title: 'Browser', icon: 'favicon.png' }} size={20} />
    )

    expect(container.querySelector('img')).toHaveAttribute('src', 'favicon.png')
    expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(container.querySelector('svg.lucide-globe')).toBeInTheDocument()
  })

  it('小程序图片保留圆形样式', () => {
    const { container } = render(
      <TabIcon
        tab={{ id: 't1', type: 'route', url: '/app/mini-app/test', title: 'Mini app', icon: 'logo.png' }}
        size={24}
      />
    )

    expect(container.querySelector('img')).toHaveAttribute('src', 'logo.png')
    expect(container.querySelector('img')).toHaveClass('rounded-full')
    expect(container.querySelector('img')).toHaveStyle({ width: '24px', height: '24px' })
  })

  it('异步小程序 logo 加载前保留尺寸占位，加载后保留圆形头像', () => {
    const tab = {
      id: 't1',
      type: 'route' as const,
      url: '/app/mini-app/test',
      title: 'Mini app',
      icon: 'miniapps:test'
    }
    const { container, rerender } = render(<TabIcon tab={tab} size={24} className="tab-icon" />)

    expect(container.querySelector('span.tab-icon')).toHaveStyle({ width: '24px', height: '24px' })
    useMiniAppLogoMock.mockReturnValueOnce({
      Avatar: ({ size, shape }: { size: number; shape: string }) => (
        <span data-testid="mini-logo" data-size={size} data-shape={shape} />
      )
    })
    rerender(<TabIcon tab={tab} size={24} />)
    expect(screen.getByTestId('mini-logo')).toHaveAttribute('data-size', '24')
    expect(screen.getByTestId('mini-logo')).toHaveAttribute('data-shape', 'circle')
  })
})
