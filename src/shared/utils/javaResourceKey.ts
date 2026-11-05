export interface JavaResourceSource {
  serverInstanceId: string
  resourceType: 'skill' | 'mcp'
  resourceId: string
}

/** Canonical escaping preserves legacy UUID keys without exposing instance IDs as paths. */
export function parseJavaResourceKey(value: string | null | undefined): JavaResourceSource | null {
  const match = value?.match(/^java-resource:([^:]+):(skill|mcp):([1-9][0-9]*)$/)
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null
  try {
    const serverInstanceId = decodeURIComponent(match[1])
    if (!serverInstanceId.trim() || encodeURIComponent(serverInstanceId) !== match[1]) return null
    return {
      serverInstanceId,
      resourceType: match[2] as JavaResourceSource['resourceType'],
      resourceId: match[3]
    }
  } catch {
    return null
  }
}
