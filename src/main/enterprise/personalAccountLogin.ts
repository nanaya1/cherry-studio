import { constants, publicEncrypt } from 'node:crypto'

interface PasswordLoginInput {
  username: string
  password: string
  captcha?: { token: string; code: string }
}

interface PasswordLoginTransport {
  baseUrl: string
  publicKey: string
  fetch: typeof fetch
}

export async function readPersonalAccountData(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('Personal account service unavailable')
  const body = await response.json()
  if (body?.code === 10009) throw new Error('Personal account captcha rejected')
  if (body?.code !== 200) throw new Error('Personal account request rejected')
  return body.data
}

export async function loginPersonalAccount(
  transport: PasswordLoginTransport,
  input: PasswordLoginInput,
  signal: AbortSignal
): Promise<{ accessToken: string; serverInstanceId: string; userId: string; username: string; displayName: string }> {
  const baseUrl = transport.baseUrl.replace(/\/+$/, '')
  const password = publicEncrypt(
    { key: transport.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(input.password, 'utf8')
  ).toString('base64')
  const login = (await readPersonalAccountData(
    await transport.fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: input.username.trim(),
        password,
        loginSource: 'CLIENT',
        ...(input.captcha && { validateToken: input.captcha.token, validateCode: input.captcha.code })
      }),
      signal
    })
  )) as { accessToken?: unknown; needSelectTenant?: unknown } | null
  if (typeof login?.accessToken !== 'string' || !login.accessToken) throw new Error('Missing personal account token')
  if (login.needSelectTenant !== false) throw new Error('Personal account requires tenant selection')

  const identity = (await readPersonalAccountData(
    await transport.fetch(`${baseUrl}/api/v1/auth/me`, {
      redirect: 'error',
      headers: { token: login.accessToken },
      signal
    })
  )) as { id?: unknown; serverInstanceId?: unknown; tenantId?: unknown; username?: unknown; showName?: unknown } | null
  if (
    typeof identity?.serverInstanceId !== 'string' ||
    !identity.serverInstanceId.trim() ||
    typeof identity.id !== 'number' ||
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0 ||
    typeof identity.tenantId !== 'number' ||
    !Number.isSafeInteger(identity.tenantId) ||
    identity.tenantId <= 0
  ) {
    throw new Error('Invalid personal account identity or missing default tenant')
  }

  const username = (typeof identity.username === 'string' && identity.username.trim()) || input.username.trim()
  const displayName = (typeof identity.showName === 'string' && identity.showName.trim()) || username
  return {
    accessToken: login.accessToken,
    serverInstanceId: identity.serverInstanceId,
    userId: String(identity.id),
    username,
    displayName
  }
}
