import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import zhCN from '@renderer/i18n/locales/zh-cn.json'

// 使用真实原语验证弹层与键盘交互，避免加载无关的整个 UI 导出图。
vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('../../../../packages/ui/src/components/primitives/button')),
  ...(await import('../../../../packages/ui/src/components/primitives/input')),
  ...(await import('../../../../packages/ui/src/components/primitives/label')),
  ...(await import('../../../../packages/ui/src/components/primitives/popover')),
  ...(await import('../../../../packages/ui/src/components/primitives/switch')),
  ...(await import('../../../../packages/ui/src/components/primitives/tabs'))
}))
// 音色标签使用固定中文目录，其余设置交互继续使用既有翻译键。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('industrial_video.voice.') ? (zhCN[key as keyof typeof zhCN] ?? key) : key)
  })
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))

import { ipcApi } from '@renderer/ipc'

import { createIndustrialVideoSettings } from './industrialVideoSettings'
import IndustrialVideoSettingsForm from './IndustrialVideoSettingsForm'

function Harness({ initialSettings = createIndustrialVideoSettings('marketing') }) {
  const [settings, setSettings] = useState(initialSettings)
  return <IndustrialVideoSettingsForm settings={settings} onChange={setSettings} />
}
afterEach(cleanup)

describe('工业视频紧凑设置交互', () => {
  it('主语言切换固定默认音色，无旁白跨语言保持关闭', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.subtitle_language' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.language.en_us' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '通用女声' })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.queryByRole('button', { name: '沉稳男声' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '无旁白' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.subtitle_language' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.language.zh_cn' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '沉稳男声' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '无旁白' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('英文仅显示精选五类加无旁白，选色与第二字幕变化不查询音色', async () => {
    vi.mocked(ipcApi.request).mockClear()
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.subtitle_language' }))
    expect(screen.queryByRole('button', { name: 'industrial_video.language.ja_jp' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'industrial_video.language.en_us' }))
    expect(
      within(screen.getByRole('group', { name: 'industrial_video.voice' }))
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['通用女声', '专业女声', '通用男声', '低沉男声', '童声女声', '无旁白'])
    await user.click(screen.getByRole('button', { name: '通用男声' }))
    await user.click(screen.getByRole('switch', { name: 'industrial_video.bilingual_subtitles' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.second_subtitle_language' }))
    await user.click(screen.getByRole('button', { name: 'industrial_video.language.zh_cn' }))
    expect(screen.getByRole('button', { name: '通用男声' })).toHaveAttribute('aria-pressed', 'true')
    expect(ipcApi.request).not.toHaveBeenCalled()
  })
  it('五个类型标签各自写入真实音色 ID，不附加情绪参数', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const settings = {
      ...createIndustrialVideoSettings('marketing'),
      subtitleLanguage: 'en-US' as const,
      voice: 'en-US-JennyNeural' as const
    }
    render(<IndustrialVideoSettingsForm settings={settings} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    for (const [label, voice] of [
      ['通用女声', 'en-US-JennyNeural'],
      ['专业女声', 'en-US-AriaNeural'],
      ['通用男声', 'en-US-GuyNeural'],
      ['低沉男声', 'en-US-ChristopherNeural'],
      ['童声女声', 'en-US-AnaNeural']
    ]) {
      await user.click(screen.getByRole('button', { name: label }))
      expect(onChange).toHaveBeenLastCalledWith({ ...settings, voice })
    }
  })
  it('非精选草稿保留原中文标签与选中状态，主动换选才改为精选 ID', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const settings = {
      ...createIndustrialVideoSettings('marketing'),
      subtitleLanguage: 'en-US' as const,
      voice: 'en-US-EricNeural' as const
    }
    const { rerender } = render(<IndustrialVideoSettingsForm settings={settings} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    const voices = within(screen.getByRole('group', { name: 'industrial_video.voice' }))
    expect(voices.getAllByRole('button')).toHaveLength(7)
    expect(voices.getByRole('button', { name: '埃里克·男声', pressed: true })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(voices.getByRole('button', { name: '低沉男声' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, voice: 'en-US-ChristopherNeural' })
    rerender(
      <IndustrialVideoSettingsForm settings={{ ...settings, voice: 'en-US-ChristopherNeural' }} onChange={onChange} />
    )
    expect(voices.queryByRole('button', { name: '埃里克·男声' })).not.toBeInTheDocument()
    expect(voices.getByRole('button', { name: '低沉男声', pressed: true })).toBeInTheDocument()
    expect(voices.getAllByRole('button')).toHaveLength(6)
  })
  it('字幕语言与双语开关按服务端语言联动，关闭字幕时保留并禁用选择', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    expect(screen.getByRole('button', { name: 'industrial_video.subtitle_language' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'industrial_video.second_subtitle_language' })).toBeDisabled()
    await user.click(screen.getByRole('switch', { name: 'industrial_video.bilingual_subtitles' }))
    expect(screen.getByRole('button', { name: 'industrial_video.second_subtitle_language' })).toBeEnabled()
    await user.click(screen.getByRole('switch', { name: 'industrial_video.subtitle' }))
    expect(screen.getByRole('button', { name: 'industrial_video.subtitle_language' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'industrial_video.bilingual_subtitles' })).toBeDisabled()
  })

  it('恢复固定中文音色且默认选中沉稳男声', async () => {
    render(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'industrial_video.appearance' }))
    expect(screen.getByRole('button', { name: '沉稳男声' })).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(screen.getByRole('group', { name: 'industrial_video.voice' }))
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['温柔女声', '知性女声', '阳光男声', '沉稳男声', '正式男声', '男孩童声', '无旁白'])
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
    expect(screen.getByRole('button', { name: '沉稳男声' })).toHaveAttribute('aria-pressed', 'true')
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
    for (const name of ['industrial_video.style.technology', '无旁白']) {
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
