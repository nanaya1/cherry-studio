import { describe, expect, it, vi } from 'vitest'

const { applicationGetMock } = vi.hoisted(() => ({
  applicationGetMock: vi.fn()
}))

vi.mock('@application', () => ({
  application: { get: applicationGetMock }
}))

import { enterpriseHandlers } from '../enterprise'

const ctx = { senderId: 'w1' }

describe('enterpriseHandlers copy mode', () => {
  it('keeps the legacy delete-report route without touching managed state', async () => {
    await expect(enterpriseHandlers['enterprise.skills.reportDeleted']({ slug: 'org-review' }, ctx)).resolves.toEqual({
      ok: true
    })

    expect(applicationGetMock).not.toHaveBeenCalled()
  })

  it('exposes fail-closed skill disable state while keeping copy-mode unavailable compatibility', async () => {
    const listDisabled = vi.fn().mockResolvedValue(['org-review'])
    applicationGetMock.mockReturnValue({ skills: { listDisabled } })

    await expect(enterpriseHandlers['enterprise.skills.listDisabled'](undefined, ctx)).resolves.toEqual({
      disabled: ['org-review']
    })
    await expect(enterpriseHandlers['enterprise.status.orgUnavailable'](undefined, ctx)).resolves.toEqual({
      unavailable: false
    })

    expect(listDisabled).toHaveBeenCalledOnce()
  })
})
