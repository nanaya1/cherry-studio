const CONNECTOR_FALLBACK_STYLES = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/15 text-chart-2',
  'bg-chart-3/15 text-chart-3',
  'bg-chart-4/15 text-chart-4',
  'bg-chart-5/15 text-chart-5',
  'bg-info-subtle text-info-subtle-foreground',
  'bg-success-subtle text-success-subtle-foreground',
  'bg-warning-subtle text-warning-subtle-foreground',
  'bg-error-subtle text-error-subtle-foreground'
]

export function getConnectorInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

export function getConnectorFallbackStyle(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return CONNECTOR_FALLBACK_STYLES[hash % CONNECTOR_FALLBACK_STYLES.length]
}
