import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import XuelangAccountSettings, { XuelangModelRefresh } from '../ProviderSpecific/XuelangAccountSettings'

const request = vi.hoisted(() => vi.fn())
vi.unmock('@cherrystudio/ui')
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
  it('runs account model synchronization when the user clicks Sync Models', async () => {
    request.mockReset()
    request.mockResolvedValue(2)
    mockDataApiService.get.mockResolvedValue([])
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <XuelangModelRefresh />
      </SWRConfig>
    )

    const sync = screen.getByRole('button', { name: 'settings.models.toolbar.pull_short' })
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(sync)
    expect(await screen.findByText('settings.models.manage.drawer_title')).toBeInTheDocument()
    await waitFor(() => expect(request).toHaveBeenCalledWith('enterprise.personal.sync_models'))
    await waitFor(() =>
      expect(mockDataApiService.get).toHaveBeenCalledWith('/models', { query: { providerId: 'xuelang' } })
    )
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
import { mockDataApiService } from '@test-mocks/renderer/DataApiService'
