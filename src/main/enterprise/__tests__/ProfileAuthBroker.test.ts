import { describe, expect, it, vi } from 'vitest'

import { computeProfileId } from '@main/core/profiles'

import { ProfileAuthBroker } from '../ProfileAuthBroker'

function setup() {
  const api = {
    getCurrentUser: vi.fn().mockResolvedValue({
      server_instance_id: 'management-instance-1',
      user: {
        id: 'management-user-1',
        group_id: 'group-a',
        role: 'member',
        status: 'active',
        username: 'Alice',
        phone: null
      }
    })
  }
  return { api, broker: new ProfileAuthBroker(api) }
}

const tokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 60_000
}

describe('ProfileAuthBroker authoritative identity', () => {
  it('normalizes numeric management user and group ids from modern', async () => {
    const { api, broker } = setup()
    api.getCurrentUser.mockResolvedValue({
      server_instance_id: 'management-instance-1',
      user: { id: 7, group_id: 2, role: 'member', status: 'active' }
    })

    const result = await broker.completeManagement('management-oauth', tokens, 7)

    expect(result.identity.subjectId).toBe('7')
    expect(result.session).toMatchObject({ userId: '7', groupId: '2' })
  })

  it('maps management exchange and oauth for the same server/user to the same profile', async () => {
    const { api, broker } = setup()

    const exchange = await broker.completeManagement('management-exchange', tokens, 'management-user-1')
    const oauth = await broker.completeManagement('management-oauth', tokens, 'management-user-1')

    expect(api.getCurrentUser).toHaveBeenCalledTimes(2)
    expect(exchange.session.accountKind).toBe('management')
    expect(exchange.identity).toEqual(oauth.identity)
    expect(computeProfileId(exchange.identity)).toBe(computeProfileId(oauth.identity))
  })

  it('separates identical subjects from different management issuers', async () => {
    const first = setup()
    const second = setup()
    second.api.getCurrentUser.mockResolvedValue({
      server_instance_id: 'management-instance-2',
      user: {
        id: 'management-user-1',
        group_id: 'group-a',
        role: 'member',
        status: 'active'
      }
    })

    const a = await first.broker.completeManagement('management-oauth', tokens, 'management-user-1')
    const b = await second.broker.completeManagement('management-oauth', tokens, 'management-user-1')

    expect(computeProfileId(a.identity)).not.toBe(computeProfileId(b.identity))
  })

  it('uses the official issuer and official user id without requiring a group', () => {
    const { broker } = setup()

    const result = broker.completeOfficial({
      issuerId: 'https://official.example',
      userId: 'official-7',
      accessToken: 'official-token',
      displayName: 'Official User',
      phone: ''
    })

    expect(result.identity).toEqual({
      kind: 'authenticated',
      accountKind: 'official',
      issuerId: 'https://official.example',
      subjectId: 'official-7'
    })
    expect(result.session.groupId).toBeNull()
  })

  it.each([
    [{ id: 'management-user-1', role: 'member', status: 'active' }, 'group_id'],
    [{ id: 'management-user-1', group_id: 'group-a', status: 'active' }, 'role'],
    [{ id: 'management-user-1', group_id: 'group-a', role: 'member' }, 'status'],
    [{ id: 'management-user-1', group_id: 'group-a', role: 'member', status: 'inactive' }, 'inactive']
  ])('fails closed for invalid currentuser %o', async (currentUser, expected) => {
    const { api, broker } = setup()
    api.getCurrentUser.mockResolvedValue({ server_instance_id: 'management-instance-1', user: currentUser })

    await expect(broker.completeManagement('management-oauth', tokens, 'management-user-1')).rejects.toThrow(expected)
  })

  it('fails closed when currentuser omits server_instance_id', async () => {
    const { api, broker } = setup()
    api.getCurrentUser.mockResolvedValue({
      user: { id: 'management-user-1', group_id: 'group-a', role: 'member', status: 'active' }
    })

    await expect(broker.completeManagement('management-oauth', tokens, 'management-user-1')).rejects.toThrow(
      'server_instance_id'
    )
  })

  it('fails closed when currentuser omits user', async () => {
    const { api, broker } = setup()
    api.getCurrentUser.mockResolvedValue({ server_instance_id: 'management-instance-1' })

    await expect(broker.completeManagement('management-oauth', tokens, 'management-user-1')).rejects.toThrow(
      'currentuser.user'
    )
  })

  it('fails closed when token response subject differs from currentuser', async () => {
    const { broker } = setup()

    await expect(broker.completeManagement('management-oauth', tokens, 'other-user')).rejects.toThrow('subject')
  })

  it('accepts an authoritative user change during runtime revalidation and returns a new identity', async () => {
    const { api, broker } = setup()
    api.getCurrentUser.mockResolvedValue({
      server_instance_id: 'management-instance-1',
      user: {
        id: 'management-user-2',
        group_id: 'group-b',
        role: 'admin',
        status: 'active'
      }
    })

    const result = await broker.revalidateManagement('management-oauth', tokens)

    expect(result.identity.subjectId).toBe('management-user-2')
    expect(result.session).toMatchObject({ userId: 'management-user-2', groupId: 'group-b', role: 'admin' })
  })

  it('discards a late authority response after generation changes', async () => {
    let resolveUser!: (value: unknown) => void
    const { api, broker } = setup()
    api.getCurrentUser.mockReturnValue(new Promise((resolve) => (resolveUser = resolve)))
    const generation = broker.generation
    const pending = broker.completeManagement('management-oauth', tokens, 'management-user-1', generation)

    broker.invalidate()
    resolveUser({
      server_instance_id: 'management-instance-1',
      user: { id: 'management-user-1', group_id: 'group-a', role: 'member', status: 'active' }
    })

    await expect(pending).rejects.toThrow('stale')
  })
})
