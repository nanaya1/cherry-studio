import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProfileBootstrapApp from '../ProfileBootstrapApp'

describe('profile login', () => {
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
