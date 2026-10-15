import Database from 'better-sqlite3'

const REQUIRED_COLUMNS: Record<string, string[]> = {
  user_provider: ['api_keys', 'auth_config'],
  remote_knowledge_service: ['api_key_encrypted'],
  preference: ['key'],
  app_state: ['key']
}

const SENSITIVE_KEY_TERMS = [
  'credential',
  'secret',
  'token',
  'oauth',
  'copilot',
  'cookie',
  'session',
  'enterprise',
  'profile',
  'identity',
  'auth'
]

const SENSITIVE_KEY_WHERE = SENSITIVE_KEY_TERMS.map(() => 'instr(lower(key), ?) > 0').join(' OR ')

export function sanitizeSafeImportDatabase(databasePath: string): void {
  const database = new Database(databasePath)
  try {
    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (columns.length === 0) throw new Error(`Safe import required table is missing: ${table}`)
      const available = new Set(columns.map(({ name }) => name))
      for (const column of requiredColumns) {
        if (!available.has(column)) throw new Error(`Safe import required column is missing: ${table}.${column}`)
      }
    }

    database.transaction(() => {
      database.prepare("UPDATE user_provider SET api_keys = '[]', auth_config = NULL").run()
      database.prepare('UPDATE remote_knowledge_service SET api_key_encrypted = NULL').run()
      database.prepare(`DELETE FROM preference WHERE ${SENSITIVE_KEY_WHERE}`).run(...SENSITIVE_KEY_TERMS)
      database.prepare(`DELETE FROM app_state WHERE ${SENSITIVE_KEY_WHERE}`).run(...SENSITIVE_KEY_TERMS)
    })()
    database.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    database.close()
  }
}
