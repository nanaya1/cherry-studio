import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cherryInOAuthService } = vi.hoisted(() => ({
  cherryInOAuthService: {
    getBalance: vi.fn(() => Promise.resolve({ balance: 1, profile: null })),
    logout: vi.fn(() => Promise.resolve())
  }
}))
vi.mock('@main/services/oauth/CherryInOAuthService', () => ({ cherryInOAuthService }))

import { cherryinHandlers } from '../cherryin'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cherryinHandlers', () => {
  it('dispatches get_balance to the service with the default provider id', async () => {
    await expect(
      cherryinHandlers['cherryin.get_balance']({ apiHost: 'https://open.cherryin.ai' }, { senderId: 'w1' })
    ).resolves.toEqual({ balance: 1, profile: null })
    expect(cherryInOAuthService.getBalance).toHaveBeenCalledWith('https://open.cherryin.ai', undefined)
  })

  it('forwards an explicit providerId (xuelang) to the service', async () => {
    await cherryinHandlers['cherryin.get_balance'](
      { apiHost: 'https://api.xuelanglm.com', providerId: 'xuelang' },
      { senderId: 'w1' }
    )
    expect(cherryInOAuthService.getBalance).toHaveBeenCalledWith('https://api.xuelanglm.com', 'xuelang')
  })

  it('dispatches logout to the service with the default provider id', async () => {
    await cherryinHandlers['cherryin.logout']({ apiHost: 'https://open.cherryin.ai' }, { senderId: 'w1' })
    expect(cherryInOAuthService.logout).toHaveBeenCalledWith('https://open.cherryin.ai', undefined)
  })
})
