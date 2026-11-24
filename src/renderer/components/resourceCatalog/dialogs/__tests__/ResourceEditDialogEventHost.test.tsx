import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'

const mocks = vi.hoisted(() => ({
  loadEditModule: vi.fn()
}))

vi.mock('../edit', () => {
  mocks.loadEditModule()

  return {
    ResourceEditDialogHost: ({ target }: { target: { kind: string; id: string } }) => (
      <div data-testid="resource-edit-dialog-host" data-kind={target.kind} data-id={target.id} />
    )
  }
})

import { ResourceEditDialogEventHost } from '../ResourceEditDialogEventHost'

describe('ResourceEditDialogEventHost', () => {
  afterEach(() => {
    EventEmitter.clearListeners()
  })

  it('loads the edit dialog only after an open request', async () => {
    render(<ResourceEditDialogEventHost />)

    expect(mocks.loadEditModule).not.toHaveBeenCalled()

    await act(async () => {
      await EventEmitter.emit(EVENT_NAMES.OPEN_RESOURCE_EDIT_DIALOG, { kind: 'agent', id: 'agent-1' })
    })

    expect(await screen.findByTestId('resource-edit-dialog-host')).toHaveAttribute('data-id', 'agent-1')
    expect(mocks.loadEditModule).toHaveBeenCalledTimes(1)
  })
})

// MEA:dual-dialog-fix 防回归：编辑弹窗宿主必须窗口级唯一。composer 变体内嵌宿主会在
// 同窗口多 composer 并存（如新建任务页 chat/agent 双 forceMount）时重复响应打开事件，
// 渲染出重叠的两个编辑弹窗。此处扫描 composer 源码，禁止宿主组件再次被内嵌渲染。
describe('ResourceEditDialogEventHost mounting policy', () => {
  const composerVariantsDir = resolve(__dirname, '../../../composer/variants')

  it('keeps the event host out of composer variants (window-level host only)', () => {
    const files = ['AgentComposer.tsx', 'ChatComposer.tsx']
    for (const file of files) {
      const source = readFileSync(resolve(composerVariantsDir, file), 'utf8')
      expect(source, `${file} must not render <ResourceEditDialogEventHost /> inline`).not.toMatch(
        /<ResourceEditDialogEventHost/
      )
    }
  })
})
