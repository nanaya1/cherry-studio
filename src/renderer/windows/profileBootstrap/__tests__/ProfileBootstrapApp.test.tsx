import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import ProfileBootstrapApp from '../ProfileBootstrapApp'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'profile_bootstrap.startup.title': 'Verify account',
          'profile_bootstrap.startup.unavailable': 'Account service is temporarily unavailable. Credentials are saved.',
          'profile_bootstrap.startup.invalid': 'Please sign in again to verify your account.',
          'profile_bootstrap.startup.retry': 'Retry verification',
          'profile_bootstrap.startup.other_account': 'Use another account',
          'profile_bootstrap.startup.checking': 'Verifying account…',
          'profile_bootstrap.startup.starting': 'Preparing workspace…',
          'profile_bootstrap.startup.error': 'Could not complete the request. Please try again.'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

/* 原启动恢复交互测试停用，统一登录行为见下方。
describe('startup verification recovery', () => {
  it('shows no password form or candidate data, retries once and keeps controls disabled while verifying', async () => {
    window.history.pushState({}, '', '?startup=1')
    let resolveRetry!: (value: { phase: 'failed'; failureKind: 'unavailable' }) => void
    const retryRecovery = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )
    const selectSignedOut = vi.fn()
    Object.defineProperty(window, 'profileBootstrap', {
      configurable: true,
      value: {
        startupState: vi.fn(async () => ({ phase: 'failed', failureKind: 'unavailable' })),
        retryRecovery,
        selectSignedOut
      }
    })
    const user = userEvent.setup()
    render(<ProfileBootstrapApp />)
    const retry = await screen.findByRole('button', { name: 'Retry verification' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('Credentials are saved.')
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument()
    await user.click(retry)
    expect(retry).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeDisabled()
    expect(retryRecovery).toHaveBeenCalledOnce()
    expect(selectSignedOut).not.toHaveBeenCalled()
    resolveRetry({ phase: 'failed', failureKind: 'unavailable' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('temporarily unavailable')
  })

  it('selects another account only on an explicit click, rather than treating a failed query as logout', async () => {
    window.history.pushState({}, '', '?startup=1')
    const selectSignedOut = vi.fn(async () => {})
    Object.defineProperty(window, 'profileBootstrap', {
      configurable: true,
      value: {
        startupState: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
        selectSignedOut
      }
    })
    const user = userEvent.setup()
    render(<ProfileBootstrapApp />)
    const button = screen.getByRole('button', { name: 'Use another account' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('Could not complete')
    expect(selectSignedOut).not.toHaveBeenCalled()
    await user.click(button)
    expect(selectSignedOut).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
  })
})

*/

describe('profile login', () => {
  it('旧 startup 参数不再展示恢复窗口，用户可直接提交密码登录', async () => {
    window.history.pushState({}, '', '?startup=1')
    const passwordLogin = vi.fn().mockResolvedValue({ kind: 'activated' })
    const startupState = vi.fn()
    Object.defineProperty(window, 'profileBootstrap', {
      configurable: true,
      value: { passwordLogin, startupState }
    })
    const user = userEvent.setup()
    render(<ProfileBootstrapApp />)
    expect(screen.getByRole('heading', { name: '企业服务登录' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry verification' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('帐号'), 'test-user')
    await user.type(screen.getByLabelText('密码'), 'test-password')
    await user.click(screen.getByRole('button', { name: /^登录$/ }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('登录成功'))
    expect(passwordLogin).toHaveBeenCalledWith({ identifier: 'test-user', password: 'test-password' })
    expect(startupState).not.toHaveBeenCalled()
  })
  it('shows only password login with the current account placeholder', () => {
    window.history.pushState({}, '', '?sso=1')
    Object.defineProperty(window, 'profileBootstrap', {
      configurable: true,
      value: { passwordLogin: vi.fn(), enterpriseLogin: vi.fn() }
    })

    render(<ProfileBootstrapApp />)

    expect(screen.getByLabelText('帐号')).toHaveAttribute('placeholder', '请输入邮箱或用户名')
    expect(screen.queryByRole('button', { name: '企业统一登录' })).not.toBeInTheDocument()
    expect(screen.queryByText(/登录即代表您已阅读并同意/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '《企业使用条款》' })).not.toBeInTheDocument()
  })

  it('keeps the account and clears the password after a failed login so the user can retry', async () => {
    window.history.pushState({}, '', '/')
    const passwordLogin = vi
      .fn()
      .mockRejectedValue(
        new Error("Error invoking remote method 'profile-bootstrap:password-login': Error: 账号或密码错误")
      )
    Object.defineProperty(window, 'profileBootstrap', { configurable: true, value: { passwordLogin } })
    render(<ProfileBootstrapApp />)
    fireEvent.change(screen.getByLabelText('帐号'), { target: { value: 'nanaya' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'incorrect' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^账号或密码错误$/))
    expect(passwordLogin).toHaveBeenCalledWith({ identifier: 'nanaya', password: 'incorrect' })
    expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('帐号').value).toBe('nanaya')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^登录$/ }).disabled).toBe(false)
  })
})
