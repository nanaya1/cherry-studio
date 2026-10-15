import { describe, expect, it } from 'vitest'

import { SwitchFence } from '../SwitchFence'

describe('SwitchFence', () => {
  it('allows writes and task starts while open', () => {
    const fence = new SwitchFence()

    expect(fence.state).toEqual({ kind: 'open' })
    expect(() => fence.assertWritable()).not.toThrow()
    expect(() => fence.assertTaskStartAllowed()).not.toThrow()
  })

  it('blocks writes and task starts after a switch begins', () => {
    const fence = new SwitchFence()

    fence.beginSwitch('550e8400-e29b-41d4-a716-446655440000')

    expect(fence.state).toEqual({ kind: 'switching', operationId: '550e8400-e29b-41d4-a716-446655440000' })
    expect(() => fence.assertWritable()).toThrow(/profile switch/i)
    expect(() => fence.assertTaskStartAllowed()).toThrow(/profile switch/i)
  })

  it('keeps the fence closed with an explicit failure state', () => {
    const fence = new SwitchFence()
    fence.beginSwitch('550e8400-e29b-41d4-a716-446655440000')

    fence.markTeardownFailed('service teardown failed')

    expect(fence.state).toMatchObject({ kind: 'teardown-failed', reason: 'service teardown failed' })
    expect(() => fence.assertWritable()).toThrow(/teardown failed/i)
  })

  it('keeps the fence closed when durable state needs recovery', () => {
    const fence = new SwitchFence()
    fence.beginSwitch('550e8400-e29b-41d4-a716-446655440000')

    fence.markNeedsRecovery('pointer durability unknown')

    expect(fence.state).toMatchObject({ kind: 'needs-recovery', reason: 'pointer durability unknown' })
    expect(() => fence.assertTaskStartAllowed()).toThrow(/recovery/i)
  })
})
