import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-mea-customizations.ts', ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

describe('MEA customization contract', () => {
  it('validates every registered touchpoint, test, and marker', () => {
    const result = run()

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('[MEA] contract valid:')
  })

  it('reports customizations affected by a git comparison base', () => {
    const result = run('--base', 'HEAD~1')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('[MEA] changed files since HEAD~1:')
  })
})
