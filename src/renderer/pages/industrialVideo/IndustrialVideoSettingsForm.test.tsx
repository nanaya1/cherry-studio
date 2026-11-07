import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 使用真实原语验证弹层与键盘交互，避免加载无关的整个 UI 导出图。
vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('../../../../packages/ui/src/components/primitives/button')),
  ...(await import('../../../../packages/ui/src/components/primitives/input')),
  ...(await import('../../../../packages/ui/src/components/primitives/label')),
  ...(await import('../../../../packages/ui/src/components/primitives/popover')),
  ...(await import('../../../../packages/ui/src/components/primitives/switch')),
  ...(await import('../../../../packages/ui/src/components/primitives/tabs'))
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import { createIndustrialVideoSettings } from './industrialVideoSettings'
import IndustrialVideoSettingsForm from './IndustrialVideoSettingsForm'

function Harness() {
  const [settings, setSettings] = useState(() => createIndustrialVideoSettings('marketing'))
  return <IndustrialVideoSettingsForm settings={settings} onChange={setSettings} />
}
afterEach(cleanup)

describe('工业视频紧凑设置交互', () => {
  it('隐藏服务端拒绝的两个女声且默认选中可用音色', async () => {
    render(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    expect(screen.queryByRole('button', { name: 'industrial_video.voice.gentle_female' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'industrial_video.voice.knowledge_female' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'industrial_video.voice.male' })).toHaveAttribute('aria-pressed', 'true')
    for (const voice of ['sunny_male', 'formal_male', 'boy', 'none']) {
      expect(screen.getByRole('button', { name: `industrial_video.voice.${voice}` })).toBeEnabled()
    }
  })
  it('时长预设与自定义切换，类型切换重置参数', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.duration' }))
    await user.click(screen.getByRole('button', { name: '2 industrial_video.minutes' }))
    expect(screen.getByRole('button', { name: 'industrial_video.duration' })).toHaveTextContent(
      '2 industrial_video.minutes'
    )
    await user.click(screen.getByRole('button', { name: 'industrial_video.duration' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.custom_duration' }))
    fireEvent.change(screen.getByLabelText('industrial_video.custom_duration'), { target: { value: '600' } })
    await user.click(screen.getByRole('button', { name: 'common.confirm' }))
    expect(screen.getByRole('button', { name: 'industrial_video.duration' })).toHaveTextContent(
      '600 industrial_video.seconds'
    )
    const typeTabs = screen.getByRole('tablist', { name: 'industrial_video.type' })
    expect(typeTabs).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'industrial_video.assembly' }))
    expect(screen.getByRole('tab', { name: 'industrial_video.assembly' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByLabelText('industrial_video.custom_duration')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'industrial_video.duration' })).toHaveTextContent(
      '30 industrial_video.seconds'
    )
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    expect(screen.getByRole('button', { name: 'industrial_video.style.realistic' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'industrial_video.voice.male' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('switch', { name: 'industrial_video.music' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'industrial_video.subtitle' })).toBeChecked()
  })

  it('比例、分辨率与弹出风格配音字幕均可修改', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    for (const [key, value] of [
      ['ratio', '1:1'],
      ['resolution', '720P']
    ]) {
      await user.click(screen.getByRole('button', { name: `industrial_video.${key}` }))
      await user.click(screen.getByRole('button', { name: value }))
      expect(screen.getByRole('button', { name: `industrial_video.${key}` })).toHaveTextContent(value)
    }
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    for (const name of ['industrial_video.style.technology', 'industrial_video.voice.none']) {
      await user.click(screen.getByRole('button', { name }))
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
    }
    for (const name of ['industrial_video.music', 'industrial_video.subtitle']) {
      await user.click(screen.getByRole('switch', { name }))
      expect(screen.getByRole('switch', { name })).not.toBeChecked()
    }
  })

  it.each(['0', '601', '1.5', ''])('拒绝非法自定义时长 %s，600秒可用', async (value) => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.duration' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.custom_duration' }))
    const input = screen.getByLabelText('industrial_video.custom_duration')
    const confirm = screen.getByRole('button', { name: 'common.confirm' })
    fireEvent.change(input, { target: { value } })
    expect(screen.getByRole('alert')).toHaveTextContent('industrial_video.invalid_duration')
    expect(confirm).toBeDisabled()
    fireEvent.change(input, { target: { value: '600' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(confirm).toBeEnabled()
  })
})
