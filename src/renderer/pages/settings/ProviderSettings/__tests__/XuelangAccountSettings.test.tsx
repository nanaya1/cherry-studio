import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import XuelangAccountSettings, { XuelangModelRefresh } from '../ProviderSpecific/XuelangAccountSettings'

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
    request.mockResolvedValue(2)
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <XuelangModelRefresh />
      </SWRConfig>
    )

    await waitFor(() => expect(request).toHaveBeenCalledWith('enterprise.personal.sync_models'))
    expect(await screen.findByRole('button', { name: 'common.refresh' })).toBeInTheDocument()
  })

  it('does not allocate a separate account settings row for signed-in users', async () => {
    request.mockReset()
    request.mockResolvedValue({ signedIn: true })
    const { container } = renderSettings()

    await waitFor(() => expect(request).toHaveBeenCalledWith('enterprise.personal.status'))
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps the existing OAuth entry for guests', async () => {
    request.mockReset()
    request.mockResolvedValue({ signedIn: false })
    renderSettings()

    expect(await screen.findByText('OAuth setup')).toBeInTheDocument()
    expect(request).not.toHaveBeenCalledWith('enterprise.personal.sync_models')
  })
})
