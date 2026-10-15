import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProfileBootstrapApp from '../ProfileBootstrapApp'

describe('profile login', () => {
  it('keeps the account and clears the password after a failed login so the user can retry', async () => {
    const passwordLogin = vi.fn().mockRejectedValue(new Error('账号或密码错误'))
    Object.defineProperty(window, 'profileBootstrap', { configurable: true, value: { passwordLogin } })
    render(<ProfileBootstrapApp />)
    fireEvent.change(screen.getByLabelText('手机号、邮箱或用户名'), { target: { value: 'nanaya' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'incorrect' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('账号或密码错误'))
    expect(passwordLogin).toHaveBeenCalledWith({ identifier: 'nanaya', password: 'incorrect' })
    expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('手机号、邮箱或用户名').value).toBe('nanaya')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^登录$/ }).disabled).toBe(false)
  })
})
