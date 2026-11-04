export type VerificationReason = 'credentials-invalid' | 'account-disabled' | 'identity-changed'

export interface VerificationEvidence {
  stage: 'current-user' | 'refresh' | 'identity' | 'session'
  endpoint: string
  kind: 'unavailable' | 'uncertain' | 'invalid'
  reason?: VerificationReason
  httpStatus?: number
  businessCode?: string | number
  retryAfterMs?: number
}

export class VerificationError extends Error {
  constructor(
    message: string,
    readonly evidence: VerificationEvidence
  ) {
    super(message)
    this.name = 'VerificationError'
  }
}

export function isDefinitiveVerificationError(error: unknown): error is VerificationError & {
  evidence: VerificationEvidence & { kind: 'invalid'; reason: VerificationReason }
} {
  return error instanceof VerificationError && error.evidence.kind === 'invalid' && error.evidence.reason !== undefined
}

export function verificationHttpError(
  stage: 'current-user' | 'refresh',
  endpoint: string,
  response: Response
): VerificationError {
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter === null ? NaN : Number(retryAfter)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  // MEA:profile-verification-network-tolerance HTTP authentication semantics are not documented by this server contract.
  return new VerificationError(`${stage} request failed (${response.status})`, {
    stage,
    endpoint,
    httpStatus: response.status,
    kind: response.status === 429 || response.status >= 500 ? 'unavailable' : 'uncertain',
    ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: Math.min(delay, 60_000) } : {})
  })
}
