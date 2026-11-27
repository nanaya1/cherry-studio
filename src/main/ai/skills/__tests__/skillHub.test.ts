import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { net } from 'electron'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { withSkillHubPackages } from '../skillHub'

vi.mock('../skillPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skillPaths')>()),
  createTempDir: () => mkdtemp(path.join(tmpdir(), 'skillhub-test-'))
}))

const target = { id: 'target', version: '1.0.0' }

async function mockDownload(corruptDependency = false) {
  vi.stubEnv('MAIN_VITE_SKILLHUB_BASE_URL', 'https://skillhub.example')
  const outer = new JSZip()
  const skills: Array<typeof target & { path: string; sha256: string }> = []
  for (const id of ['target', 'dependency']) {
    const inner = new JSZip()
    inner.file('SKILL.md', `---\nname: ${id}\ndescription: Example skill\n---\n`)
    const bytes = await inner.generateAsync({ type: 'nodebuffer' })
    const entry = `skills/${id}/package.zip`
    outer.file(entry, bytes)
    skills.push({
      id,
      version: target.version,
      path: entry,
      sha256:
        corruptDependency && id === 'dependency' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')
    })
  }
  outer.file('manifest.json', JSON.stringify({ format: 'skillhub-offline-v1', skills }))
  const bytes = await outer.generateAsync({ type: 'uint8array' })
  vi.mocked(net.fetch).mockResolvedValueOnce(
    new Response(new Uint8Array(bytes), {
      headers: { 'content-type': 'application/zip' }
    })
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(net.fetch).mockReset()
})

describe('SkillHub offline download', () => {
  it('stages dependencies ahead of the requested skill', async () => {
    await mockDownload()
    const result = await withSkillHubPackages(target, async (packages) =>
      Promise.all(
        packages.map(async (item) => [item.id, await readFile(path.join(item.directory, 'SKILL.md'), 'utf8')])
      )
    )
    expect(result).toEqual([
      ['dependency', expect.stringContaining('name: dependency')],
      ['target', expect.stringContaining('name: target')]
    ])
  })

  it('rejects a tampered dependency before making any member available to the installer', async () => {
    await mockDownload(true)
    const install = async () => {
      throw new Error('Unexpected write')
    }
    await expect(withSkillHubPackages(target, install)).rejects.toThrow('Package checksum mismatch: dependency')
  })
})
