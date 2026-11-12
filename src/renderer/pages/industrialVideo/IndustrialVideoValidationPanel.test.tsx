import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import type { Storyboard } from './industrialVideoValidation'
import IndustrialVideoValidationPanel from './IndustrialVideoValidationPanel'

// 全局 renderer.setup 已桩 @cherrystudio/ui / @data / @logger，这里只替换面板依赖。
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
// 只读复用 ModelSelector：测试里自动选中一个模型以启用动作按钮。
vi.mock('@renderer/components/ModelSelector', async () => {
  const React = await import('react')
  return {
    ModelSelector: ({ trigger, onSelect }: { trigger: React.ReactNode; onSelect: (model: unknown) => void }) => {
      const called = React.useRef(false)
      React.useEffect(() => {
        if (!called.current) {
          called.current = true
          onSelect({ id: 'test::model', name: '测试模型' })
        }
      }, [onSelect])
      return trigger
    }
  }
})

function validStoryboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    video_title: '测试视频',
    scenes: [
      {
        id: 1,
        title: 'Intro',
        duration: 8,
        prompt: 'A factory floor with robots.',
        prompt_en: 'A factory floor with robots and bright lighting.',
        narration: [{ text: '欢迎来到本工厂', start: 0, end: 3 }]
      }
    ],
    ...overrides
  }
}

function jsonOf(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
}

// 面板把分镜以「无代码围栏」的 pretty JSON 展示在只读文本框中。
function prettyOf(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

beforeEach(() => {
  vi.clearAllMocks()
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `uuid-${Math.random()}` })
  }
})

afterEach(cleanup)

describe('IndustrialVideoValidationPanel', () => {
  it('默认渲染输入与动作按钮，且生成分镜在无需求时禁用', async () => {
    render(<IndustrialVideoValidationPanel />)
    expect(await screen.findByRole('textbox', { name: '视频需求' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '资料事实' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '分析资料' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '生成分镜' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '定向修改' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  })

  it('生成分镜：模型返回合规 JSON 后展示已校验分镜', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(validStoryboard()) }) as never
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    const board = await screen.findByRole('textbox', { name: '已校验分镜' })
    expect(board).toHaveValue(prettyOf(validStoryboard()))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('定向修改越界：变更落在未开放路径则保留原分镜并展示差异', async () => {
    const base = validStoryboard()
    const revised = validStoryboard()
    revised.scenes[0].duration = 12
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    // 生成阶段返回 base（duration=8）。
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    // 修改阶段返回 revised（duration=12）。
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(revised) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '延长首镜')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/title')
    await user.click(screen.getByRole('button', { name: '定向修改' }))

    // 越界：rejectedPaths 含 /scenes/0/duration，原分镜 duration 仍为 8。
    expect(await screen.findByText(/修改越界/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '已校验分镜' })).toHaveValue(prettyOf(base))
    expect(screen.getByRole('textbox', { name: '模型建议分镜' })).toHaveValue(prettyOf(revised))
  })

  it('定向修改允许：变更落在开放路径则采纳修订分镜', async () => {
    const base = validStoryboard()
    const revised = validStoryboard()
    revised.scenes[0].duration = 12
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(revised) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '延长首镜')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/duration')
    await user.click(screen.getByRole('button', { name: '定向修改' }))

    expect(await screen.findByRole('textbox', { name: '已校验分镜' })).toHaveValue(prettyOf(revised))
    expect(screen.queryByText(/修改越界/)).not.toBeInTheDocument()
  })

  it('重设需求/事实后旧资料分析被清除，避免污染', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: '分析结论内容' }) as never
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    await user.click(screen.getByRole('button', { name: '分析资料' }))
    expect(await screen.findByRole('textbox', { name: '资料分析' })).toHaveValue('分析结论内容')
    // 修改需求触发 invalidateStoryboard，应清除旧分析。
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '新需求')
    expect(screen.queryByRole('textbox', { name: '资料分析' })).not.toBeInTheDocument()
  })

  it('生成分镜把已有资料分析纳入提示，且分析调用不重复旧分析', async () => {
    const calls: { system: string; text: string }[] = []
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string, args: unknown) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') {
        const a = args as { system: string; uiMessages: { parts: { text: string }[] }[] }
        calls.push({ system: a.system, text: a.uiMessages[0].parts[0].text })
        const isGenerate = a.system.includes('分镜编剧')
        return Promise.resolve({ text: isGenerate ? jsonOf(validStoryboard()) : '分析结论内容' }) as never
      }
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '需求')
    await user.click(screen.getByRole('button', { name: '分析资料' }))
    expect(await screen.findByRole('textbox', { name: '资料分析' })).toHaveValue('分析结论内容')

    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    const generateCall = calls.find((call) => call.system.includes('分镜编剧'))
    const analyzeCall = calls.find((call) => call.system.includes('策划助手'))
    expect(generateCall).toBeDefined()
    expect(generateCall!.text).toContain('分析结论内容')
    expect(generateCall!.text).toContain('【资料分析】')
    // 分析调用本身不应重复旧分析。
    expect(analyzeCall!.text).not.toContain('【资料分析】')
  })

  it('系统提示包含资料不可信、无工具、不编造的约束', async () => {
    const systems: string[] = []
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string, args: unknown) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') {
        systems.push((args as { system: string }).system)
        return Promise.resolve({ text: jsonOf(validStoryboard()) }) as never
      }
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '需求')
    await user.click(screen.getByRole('button', { name: '分析资料' }))
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })
    expect(systems.length).toBeGreaterThan(0)
    for (const system of systems) {
      expect(system).toContain('不可信')
      expect(system).toContain('不存在')
      expect(system).toContain('不编造')
    }
  })

  it('运行中锁定输入，取消后解锁且不采纳迟到结果', async () => {
    let resolveGenerate!: (value: unknown) => void
    vi.mocked(ipcApi.request).mockImplementation((channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate')
        return new Promise((resolve) => {
          resolveGenerate = resolve
        }) as never
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    const requirement = await screen.findByRole('textbox', { name: '视频需求' })
    await user.type(requirement, '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))

    // 运行中：输入锁定，取消可用。
    await waitFor(() => expect(requirement).toBeDisabled())
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '取消' }))

    // 取消后解锁。
    await waitFor(() => expect(requirement).toBeEnabled())
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()

    // 迟到结果到达：不采纳，无分镜展示。
    await act(async () => {
      resolveGenerate({ text: jsonOf(validStoryboard()) })
    })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '已校验分镜' })).not.toBeInTheDocument())
  })

  it('定向修改原样返回：展示 status 提示“模型未产生有效修改，原分镜保持不变。”并保留原分镜', async () => {
    const base = validStoryboard()
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    // 修改阶段：模型返回完全相同，无有效修改。
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '无需改动')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/duration')
    await user.click(screen.getByRole('button', { name: '定向修改' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('模型未产生有效修改，原分镜保持不变。')
    // 原分镜保持不变。
    expect(screen.getByRole('textbox', { name: '已校验分镜' })).toHaveValue(prettyOf(base))
    // 不应误报采纳。
    expect(status).not.toHaveTextContent('修改已采纳')
  })

  it('定向修改有效：采纳后展示 status 提示“修改已采纳。”', async () => {
    const base = validStoryboard()
    const revised = validStoryboard()
    revised.scenes[0].duration = 12
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(revised) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '延长首镜')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/duration')
    await user.click(screen.getByRole('button', { name: '定向修改' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('修改已采纳。')
    expect(screen.getByRole('textbox', { name: '已校验分镜' })).toHaveValue(prettyOf(revised))
  })

  it('改动需求/事实使旧状态失效：清除成功 status 与原分镜', async () => {
    const base = validStoryboard()
    const revised = validStoryboard()
    revised.scenes[0].duration = 12
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(revised) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '延长首镜')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/duration')
    await user.click(screen.getByRole('button', { name: '定向修改' }))
    expect(await screen.findByRole('status')).toHaveTextContent('修改已采纳。')

    // 改动需求触发失效：status 与原分镜应被清除。
    await user.type(screen.getByRole('textbox', { name: '视频需求' }), '新需求')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '已校验分镜' })).not.toBeInTheDocument()
  })

  it('定向修改越界：保留原分镜且不残留成功 status', async () => {
    const base = validStoryboard()
    const revised = validStoryboard()
    revised.scenes[0].duration = 12 // 先成功采纳
    const overstep = validStoryboard()
    overstep.scenes[0].title = 'Overstep' // 越界路径 /scenes/0/title
    const user = userEvent.setup()
    render(<IndustrialVideoValidationPanel />)
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(base) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(await screen.findByRole('textbox', { name: '视频需求' }), '制作设备宣传片')
    await user.click(screen.getByRole('button', { name: '生成分镜' }))
    await screen.findByRole('textbox', { name: '已校验分镜' })

    // 第一次修改：允许 duration，采纳成功。
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(revised) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '延长首镜')
    await user.type(screen.getByRole('textbox', { name: '允许修改的 JSON 路径' }), '/scenes/0/duration')
    await user.click(screen.getByRole('button', { name: '定向修改' }))
    expect(await screen.findByRole('status')).toHaveTextContent('修改已采纳。')

    // 第二次修改：越界变更 title，应拒绝并清除成功 status。
    vi.mocked(ipcApi.request).mockImplementation(async (channel: string) => {
      if (channel === 'ai.text.abort') return Promise.resolve(undefined)
      if (channel === 'ai.text.generate') return Promise.resolve({ text: jsonOf(overstep) }) as never
      return Promise.resolve(undefined)
    })
    await user.type(screen.getByRole('textbox', { name: '修订要求' }), '改标题')
    await user.click(screen.getByRole('button', { name: '定向修改' }))

    expect(await screen.findByText(/修改越界/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // 原分镜（已采纳的 duration=12 版本）保持不变，未误用越界建议。
    expect(screen.getByRole('textbox', { name: '已校验分镜' })).toHaveValue(prettyOf(revised))
  })
})
