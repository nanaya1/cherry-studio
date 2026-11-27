import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import XuelangAccountSettings from '../ProviderSpecific/XuelangAccountSettings'

const request = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.mock('../ProviderSpecific/CherryInOauth', () => ({ default: () => <div>OAuth setup</div> }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function renderSettings() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <XuelangAccountSettings providerId="xuelang" />
    </SWRConfig>
  )
}

describe('XuelangAccountSettings', () => {
  it('automatically asks the main process to sync on entry for an account', async () => {
    request.mockReset()
    request.mockResolvedValueOnce({ signedIn: true }).mockResolvedValueOnce(2)
    renderSettings()

    await waitFor(() => expect(request).toHaveBeenCalledWith('enterprise.personal.sync_models'))
    expect(screen.queryByText('OAuth setup')).not.toBeInTheDocument()
  })

  it('keeps the existing OAuth entry for guests', async () => {
    request.mockReset()
    request.mockResolvedValue({ signedIn: false })
    renderSettings()

    expect(await screen.findByText('OAuth setup')).toBeInTheDocument()
    expect(request).not.toHaveBeenCalledWith('enterprise.personal.sync_models')
  })
})
