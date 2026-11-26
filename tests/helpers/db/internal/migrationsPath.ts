import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the production Drizzle migrations folder.
 *
 * Resolved relative to this module's own location so it works under Vitest's
 * `transform`-based module runner — hardcoded `process.cwd()` is unreliable
 * when tests run from different working directories.
 */
export function resolveMigrationsPath(): string {
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = dirname(thisFile)
  // tests/helpers/db/internal/migrationsPath.ts → repo root is 4 levels up
  return resolve(thisDir, '../../../../migrations/sqlite-drizzle')
}

/** Copy the real migration chain strictly before `before` into an isolated fixture folder. */
export function copyMigrationPrefix(destination: string, before: string): { initial: string; forward: string } {
  const source = resolveMigrationsPath()
  const journal = JSON.parse(readFileSync(resolve(source, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[]
  }
  const bundledTag = '0034_upstream_v2_2_3'
  const exact = journal.entries.findIndex((entry) => entry.tag === before)
  const end = exact >= 0 ? exact : journal.entries.findIndex((entry) => entry.tag === bundledTag)
  if (end < 0) throw new Error(`Unknown migration: ${before}`)

  const entries = journal.entries.slice(0, end)
  mkdirSync(resolve(destination, 'meta'), { recursive: true })
  for (const { tag } of entries) copyFileSync(resolve(source, `${tag}.sql`), resolve(destination, `${tag}.sql`))

  let forward = source
  if (exact < 0) {
    // Some upstream fixtures start halfway through MEA's bundled upgrade.
    // Split the actual SQL only in the fixture, keeping the released journal intact.
    const filename = `${bundledTag}.sql`
    const sql = readFileSync(resolve(source, filename), 'utf8')
    const marker = `-- Upstream ${before}\n`
    const split = sql.indexOf(marker)
    if (split < 0) throw new Error(`Unknown migration: ${before}`)
    if (split > 0) {
      const bundled = journal.entries[end]
      entries.push({ ...bundled, when: bundled.when - 1 })
      writeFileSync(resolve(destination, filename), sql.slice(0, split).replace(/--> statement-breakpoint\s*$/, ''))

      forward = resolve(destination, 'forward')
      mkdirSync(resolve(forward, 'meta'), { recursive: true })
      writeFileSync(resolve(forward, filename), sql.slice(split))
      writeFileSync(resolve(forward, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [bundled] }))
    }
  }
  writeFileSync(resolve(destination, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return { initial: destination, forward }
}
