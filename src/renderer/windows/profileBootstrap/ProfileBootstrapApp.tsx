import { Eye, EyeOff } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'

// 仅声明引导窗口使用的桥接能力，不引入业务窗口 API。
declare global {
  interface Window {
    profileBootstrap: {
      passwordLogin(input: { identifier: string; password: string }): Promise<unknown>
      enterpriseLogin(): Promise<unknown>
    }
  }
}

const PROFILE_BOOTSTRAP_ERROR_PREFIX = /^Error invoking remote method 'profile-bootstrap:[^']+': (?:Error: )?/

function getErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(PROFILE_BOOTSTRAP_ERROR_PREFIX, '')
}

export default function ProfileBootstrapApp() {
  const startup = new URLSearchParams(window.location.search).get('startup') === '1'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  // 参考登录页固定使用浅色主题，保留原深色状态便于后续恢复。
  // const [dark, setDark] = useState(false)
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
      const message = getErrorMessage(cause)
      setError(message.includes('ERR_CONNECTION_REFUSED') ? '无法连接企业服务，请检查服务地址或联系管理员。' : message)
    } finally {
      setPassword('')
      setLoading(false)
      submitting.current = false
    }
  }

  if (startup) {
    return (
      <main className="profile-login profile-startup">
        <header className="brand-header" aria-label="MEA Cowork 企业版">
          <img src={AppLogo} alt="" />
          <span>MEA Cowork 企业版</span>
        </header>
        <section className="form-panel" aria-label="正在准备工作空间">
          <div className="startup-card" role="status" aria-live="polite">
            <div className="startup-mark" aria-hidden="true">
              <span />
            </div>
            <p className="startup-kicker">WORKSPACE</p>
            <h1>正在准备工作空间</h1>
            <p className="startup-detail">正在安全加载你的账号数据和业务服务，请稍候。</p>
            <div className="startup-progress" aria-hidden="true">
              <span />
            </div>
            <p className="startup-footnote">准备完成后将自动进入会话页面</p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="profile-login">
      {/* 原双栏品牌面板已停用，改为与参考图一致的单列企业登录页。 */}
      <header className="brand-header" aria-label="MEA Cowork 企业版">
        <img src={AppLogo} alt="" />
        <span>MEA Cowork 企业版</span>
      </header>
      <section className="form-panel" aria-label="账号登录">
        <form className="login-form" onSubmit={submit} aria-busy={loading}>
          <h1>企业服务登录</h1>
          <div className="form-item">
            <label htmlFor="identifier">帐号</label>
            <Input
              id="identifier"
              name="identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              // placeholder="请输入手机号、邮箱或用户名"
              placeholder="请输入邮箱或用户名"
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
                placeholder="请输入密码"
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
          <p className="password-hint">首次使用密码登录请联系管理员设置密码</p>
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="login-submit" disabled={loading}>
            {loading ? '正在登录…' : '登录'}
          </Button>
          {/* 停用企业统一登录入口，保留原逻辑便于恢复。
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
                  setError(getErrorMessage(cause))
                }
              }}>
              企业统一登录
            </Button>
          )} */}
          {/* <div className="account-links">
            <p>
              还没有账号？
              <Button type="button" variant="link" onClick={() => setNotice('请联系企业管理员创建账号。')}>
                注册新账号
              </Button>
            </p>
            <Button type="button" variant="link" onClick={() => setNotice('请联系企业管理员重置密码。')}>
              忘记密码？请联系企业管理员重置
            </Button>
          </div> */}
          {/* 停用企业使用条款提示，保留原文案便于恢复。
          <p className="agreement">
            登录即代表您已阅读并同意
            <Button
              type="button"
              variant="link"
              onClick={() => setNotice('请联系企业管理员获取本企业适用的企业使用条款。')}>
              《企业使用条款》
            </Button>
          </p> */}
          <p className="login-notice" role="status" aria-live="polite">
            {notice}
          </p>
        </form>
      </section>
    </main>
  )
}
