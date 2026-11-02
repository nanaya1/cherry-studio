import { describe, expect, it, vi } from 'vitest'

const { applicationGetMock } = vi.hoisted(() => ({
  applicationGetMock: vi.fn()
}))

vi.mock('@application', () => ({
  application: { get: applicationGetMock }
}))

import { enterpriseRequestSchemas, enterpriseStatusSchema } from '@shared/ipc/schemas/enterprise'

import { enterpriseHandlers } from '../enterprise'

const ctx = { senderId: 'w1' }

describe('enterprise 登录生命周期契约', () => {
  it('取消输入严格校验 attemptId，输出保持布尔 ok', () => {
    const route = enterpriseRequestSchemas['enterprise.login.cancel']
    expect(route.input.parse({ attemptId: 'a1' })).toEqual({ attemptId: 'a1' })
    for (const input of [undefined, {}, { attemptId: 1 }, { attemptId: 'a1', extra: true }]) {
      expect(route.input.safeParse(input).success).toBe(false)
    }
    expect(route.output.parse({ ok: false })).toEqual({ ok: false })
  })

  it('状态兼容旧 mock，接受且验证生命周期字段', () => {
    const legacy = { phase: 'signed-out', authMode: 'management-oauth', displayName: null, phone: null, role: null }
    expect(enterpriseStatusSchema.safeParse(legacy).success).toBe(true)
    expect(
      enterpriseStatusSchema.safeParse({ ...legacy, loginAttemptId: null, loginStartedAt: null, loginError: 'timeout' })
        .success
    ).toBe(true)
    expect(enterpriseStatusSchema.safeParse({ ...legacy, loginError: 'unknown' }).success).toBe(false)
  })

  it('取消处理器透传身份并返回真实结果', async () => {
    const cancelLogin = vi.fn((id: string) => ({ ok: id === 'current' }))
    applicationGetMock.mockReturnValue({ auth: { cancelLogin } })
    await expect(enterpriseHandlers['enterprise.login.cancel']({ attemptId: 'stale' }, ctx)).resolves.toEqual({
      ok: false
    })
    await expect(enterpriseHandlers['enterprise.login.cancel']({ attemptId: 'current' }, ctx)).resolves.toEqual({
      ok: true
    })
    expect(cancelLogin.mock.calls).toEqual([['stale'], ['current']])
    applicationGetMock.mockClear()
  })
})

describe('enterpriseHandlers copy mode', () => {
  it('keeps the legacy delete-report route without touching managed state', async () => {
    await expect(enterpriseHandlers['enterprise.skills.reportDeleted']({ slug: 'org-review' }, ctx)).resolves.toEqual({
      ok: true
    })

    expect(applicationGetMock).not.toHaveBeenCalled()
  })

  it('does not expose managed disable or unavailable state', async () => {
    await expect(enterpriseHandlers['enterprise.skills.listDisabled'](undefined, ctx)).resolves.toEqual({
      disabled: []
    })
    await expect(enterpriseHandlers['enterprise.status.orgUnavailable'](undefined, ctx)).resolves.toEqual({
      unavailable: false
    })

    expect(applicationGetMock).not.toHaveBeenCalled()
  })
})
