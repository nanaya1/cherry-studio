import { Eye, EyeOff } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '@cherrystudio/ui'

// 仅声明引导窗口使用的桥接能力，不引入业务窗口 API。
declare global {
  interface Window {
    profileBootstrap: {
      passwordLogin(input: { identifier: string; password: string }): Promise<unknown>
      enterpriseLogin(): Promise<unknown>
    }
  }
}

export default function ProfileBootstrapApp() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [dark, setDark] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const submitting = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setLoading(true)
    setError('')
    setNotice('')
    try {
      await window.profileBootstrap.passwordLogin({ identifier, password })
      setNotice('登录成功，正在准备工作空间…')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message.includes('ERR_CONNECTION_REFUSED') ? '无法连接企业服务，请检查服务地址或联系管理员。' : message)
    } finally {
      setPassword('')
      setLoading(false)
      submitting.current = false
    }
  }

  return (
    <main className={`profile-login${dark ? ' dark' : ''}`}>
      <section className="brand-panel" aria-label="Cherry Studio 企业平台">
        <div className="mark">Cherry Studio</div>
        <div className="brand-copy">
          <h1>
            企业级 AI
            <br />
            生产力平台
          </h1>
          <p>统一管理团队、模型与智能资源，让 AI 能力安全地进入每个工作流程。</p>
        </div>
        <ul>
          <li>
            <b>01</b>
            <span>
              高效智能
              <br />
              <small>AI 驱动的智能助手</small>
            </span>
          </li>
          <li>
            <b>02</b>
            <span>
              安全可靠
              <br />
              <small>企业级权限和数据隔离</small>
            </span>
          </li>
          <li>
            <b>03</b>
            <span>
              统一模型管理
              <br />
              <small>集中配置与用量洞察</small>
            </span>
          </li>
        </ul>
      </section>
      <section className="form-panel" aria-label="账号登录">
        <div className="top-actions">
          <span>简体中文</span>
          <label className="theme-control">
            <input
              type="checkbox"
              role="switch"
              aria-label="深色"
              checked={dark}
              onChange={(event) => setDark(event.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
            深色
          </label>
        </div>
        <form className="login-form" onSubmit={submit} aria-busy={loading}>
          <div className="wordmark">
            Cherry Studio <span>Enterprise</span>
          </div>
          <h2>欢迎回来</h2>
          <div className="form-item">
            <label htmlFor="identifier">手机号、邮箱或用户名</label>
            <Input
              id="identifier"
              name="identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="请输入手机号、邮箱或用户名"
              autoComplete="username"
              required
              disabled={loading}
              autoFocus
            />
          </div>
          <div className="form-item">
            <label htmlFor="password">密码</label>
            <div className="password-field">
              <Input
                id="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                disabled={loading}
              />
              <Button
                type="button"
                variant="ghost"
                className="password-toggle"
                aria-label={visible ? '隐藏密码' : '显示密码'}
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}>
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
            </div>
          </div>
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="login-submit" disabled={loading}>
            {loading ? '正在登录…' : '登录'}
          </Button>
          {new URLSearchParams(window.location.search).get('sso') === '1' && (
            <Button
              type="button"
              variant="link"
              disabled={loading}
              onClick={async () => {
                setError('')
                try {
                  await window.profileBootstrap.enterpriseLogin()
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause))
                }
              }}>
              企业统一登录
            </Button>
          )}
          <div className="links">
            <Button type="button" variant="link" onClick={() => setNotice('请联系企业管理员创建账号或重置密码')}>
              账号或密码问题？
            </Button>
          </div>
          <p className="agreement">
            登录即表示同意{' '}
            <Button
              type="button"
              variant="link"
              onClick={() => setNotice('请联系企业管理员获取本企业适用的隐私协议。')}>
              《隐私协议》
            </Button>
          </p>
          <p className="login-notice" role="status" aria-live="polite">
            {notice}
          </p>
        </form>
      </section>
    </main>
  )
}
