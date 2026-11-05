import { Eye, EyeOff } from 'lucide-react'
// import { useEffect, useRef, useState, type FormEvent } from 'react'
// import { useTranslation } from 'react-i18next'
import { useRef, useState, type FormEvent } from 'react'

import { Button, Input } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'

// 仅声明引导窗口使用的桥接能力，不引入业务窗口 API。
declare global {
  interface Window {
    profileBootstrap: {
      passwordLogin(input: { identifier: string; password: string }): Promise<unknown>
      enterpriseLogin(): Promise<unknown>
      // startupState(): Promise<StartupState>
      // retryRecovery(): Promise<StartupState>
      // selectSignedOut(): Promise<void>
    }
  }
}

const PROFILE_BOOTSTRAP_ERROR_PREFIX = /^Error invoking remote method 'profile-bootstrap:[^']+': (?:Error: )?/

function getErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(PROFILE_BOOTSTRAP_ERROR_PREFIX, '')
}

/* 原启动恢复界面及状态类型停用，保留以便恢复。
type StartupState = {
  phase: 'failed' | 'verifying' | 'starting' | 'selecting'
  failureKind?: 'unavailable' | 'invalid'
}

function StartupRecovery() {
  const { t } = useTranslation()
  const [state, setState] = useState<StartupState>({ phase: 'verifying' })
  const [error, setError] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    let current = true
    void window.profileBootstrap.startupState().then(
      (value) => {
        if (current) setState(value)
      },
      () => {
        if (current) {
          setState({ phase: 'failed', failureKind: 'unavailable' })
          setError(true)
        }
      }
    )
    return () => {
      current = false
    }
  }, [])
  const busy = state.phase !== 'failed'
  const act = async (otherAccount: boolean) => {
    if (pending.current || busy) return
    pending.current = true
    setError(false)
    setState({ ...state, phase: otherAccount ? 'selecting' : 'verifying' })
    try {
      if (otherAccount) await window.profileBootstrap.selectSignedOut()
      else setState(await window.profileBootstrap.retryRecovery())
    } catch {
      setState({ phase: 'failed', failureKind: state.failureKind ?? 'unavailable' })
      setError(true)
    } finally {
      pending.current = false
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <section className="flex max-w-md flex-col gap-6" aria-busy={busy}>
        <h1 className="text-xl font-medium">{t('profile_bootstrap.startup.title')}</h1>
        <p role="status" className="text-muted-foreground">
          {t(
            state.phase === 'failed'
              ? state.failureKind === 'invalid'
                ? 'profile_bootstrap.startup.invalid'
                : 'profile_bootstrap.startup.unavailable'
              : state.phase === 'starting'
                ? 'profile_bootstrap.startup.starting'
                : 'profile_bootstrap.startup.checking'
          )}
        </p>
        {error && (
          <p role="alert" className="text-error">
            {t('profile_bootstrap.startup.error')}
          </p>
        )}
        <div className="flex gap-3">
          <Button disabled={busy} onClick={() => void act(false)}>
            {t('profile_bootstrap.startup.retry')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void act(true)}>
            {t('profile_bootstrap.startup.other_account')}
          </Button>
        </div>
      </section>
    </main>
  )
}

*/

export default function ProfileBootstrapApp() {
  // if (new URLSearchParams(window.location.search).get('startup') === '1') return <StartupRecovery />
  // MEA:profile-verification-network-tolerance 启动验证失败由主进程先切到 signed-out，再进入现有登录页。
  return <PasswordLogin />
}

function PasswordLogin() {
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
            {/* <label htmlFor="identifier">帐号</label> */}
            <label htmlFor="identifier">用户名</label>
            <Input
              id="identifier"
              name="identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              // placeholder="请输入手机号、邮箱或用户名"
              // placeholder="请输入邮箱或用户名"
              placeholder="请输入用户名"
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
