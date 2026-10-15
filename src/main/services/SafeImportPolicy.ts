const SENSITIVE_SEGMENTS = new Set([
  'credentials',
  'sensitive',
  'cookies',
  'session',
  'sessions',
  'session storage',
  'oauth',
  'copilot',
  'enterprise',
  'control',
  'profile',
  'profile metadata'
])

const SENSITIVE_FILE_NAMES = new Set(['profile-metadata.json', 'profiles.json', 'active-profile.json'])

export function shouldStripSafeImportPath(relativePath: string): boolean {
  const segments = relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())

  return segments.some((segment) => SENSITIVE_SEGMENTS.has(segment) || SENSITIVE_FILE_NAMES.has(segment))
}
