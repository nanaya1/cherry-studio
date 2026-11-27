import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { net } from 'electron'
import * as z from 'zod'

import { skillHubFilters, skillHubItem, skillHubPage, skillHubSelection } from '@shared/types/skillHub'

import { validatePortableArchive } from './cherrySkillMarketplace'
import { assertSkillDirectoryWithinLimits, extractZip, MAX_SKILL_SIZE, resolveSkillDirectory } from './skillArchive'
import { createTempDir, safeRemoveDirectory } from './skillPaths'

type Selection = z.infer<typeof skillHubSelection>
type StagedSkill = Selection & { directory: string }
const maxArchiveBytes = 520 * 1024 * 1024
const envelope = z.object({ code: z.number(), msg: z.string().optional(), data: z.unknown() })
const manifestSchema = z.object({
  format: z.literal('skillhub-offline-v1'),
  skills: z
    .array(
      skillHubSelection.extend({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
    )
    .min(1)
    .max(500)
})

function marketUrl(endpoint: string): URL | null {
  const configured = import.meta.env.MAIN_VITE_SKILLHUB_BASE_URL?.trim()
  if (!configured) return null
  const base = new URL(configured)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Invalid SkillHub service address')
  }
  return new URL(`/api/v1/public/market/${endpoint}`, base)
}

async function request(url: URL, options: RequestInit = {}) {
  const response = await net.fetch(url.href, {
    ...options,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(options.method === 'POST' ? 180_000 : 15_000)
  })
  if (!response.ok) throw new Error(`SkillHub HTTP ${response.status}`)
  return response
}

async function readJson(response: Response) {
  if (!response.body) throw new Error('Empty SkillHub response')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 4 * 1024 * 1024) throw new Error('SkillHub response is too large')
    chunks.push(Buffer.from(chunk))
  }
  const result = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (result.code !== 200) throw new Error(result.msg || 'SkillHub request failed')
  return result.data
}

export async function getSkillHubFilters() {
  const url = marketUrl('filters')
  return url ? skillHubFilters.parse(await readJson(await request(url))) : null
}

export async function listSkillHub(query: Record<string, string | number>) {
  const url = marketUrl('skills')
  if (!url) return null
  url.searchParams.set('pageSize', '12')
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, String(value))
  const page = skillHubPage.parse(await readJson(await request(url)))
  for (const item of page.records) {
    const icon = item.iconUrl && new URL(item.iconUrl, url)
    item.iconUrl =
      icon && icon.origin === url.origin && /^\/api\/v1\/public\/skill-icons\/[a-f0-9]{32}$/.test(icon.pathname)
        ? icon.href
        : undefined
  }
  return page
}

export async function getSkillHubDetail(id: string) {
  const url = marketUrl(`skills/${id}`)
  if (!url) throw new Error('SkillHub is not configured')
  const item = skillHubItem.parse(await readJson(await request(url)))
  if (item.id !== id) throw new Error('Unexpected SkillHub skill')
  return item
}

export async function withSkillHubPackages<T>(
  target: Selection,
  install: (packages: StagedSkill[]) => Promise<T>
): Promise<T> {
  const url = marketUrl('downloads/zip')
  if (!url) throw new Error('SkillHub is not configured')
  const temp = await createTempDir('skillhub')
  try {
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: [target] })
    })
    if (!response.headers.get('content-type')?.startsWith('application/zip')) {
      await readJson(response)
      throw new Error('Expected a SkillHub ZIP')
    }
    if (!response.body) throw new Error('Empty SkillHub ZIP')
    const archive = path.join(temp, 'market.zip')
    let size = 0
    await pipeline(
      Readable.from(response.body),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > maxArchiveBytes) callback(new Error('SkillHub ZIP is too large'))
          else callback(null, chunk)
        }
      }),
      createWriteStream(archive)
    )
    const outer = path.join(temp, 'outer')
    await mkdir(outer)
    await validatePortableArchive(archive)
    await extractZip(archive, outer, maxArchiveBytes)
    const manifestPath = path.join(outer, 'manifest.json')
    if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('SkillHub manifest is too large')
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (
      new Set(manifest.skills.map(({ id }) => id)).size !== manifest.skills.length ||
      !manifest.skills.some(({ id, version }) => id === target.id && version === target.version)
    ) {
      throw new Error('Invalid SkillHub package selection')
    }
    const packages: StagedSkill[] = []
    const staging = path.join(temp, 'staged')
    await mkdir(staging)
    for (const item of manifest.skills) {
      if (item.path !== `skills/${item.id}/package.zip` && item.path !== `skills/${item.id}/package.xlp`) {
        throw new Error(`Unexpected package path for ${item.id}`)
      }
      const source = path.join(outer, item.path)
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(source)) digest.update(chunk)
      if (digest.digest('hex') !== item.sha256) throw new Error(`Package checksum mismatch: ${item.id}`)
      const folder = path.join(temp, `skill-${item.id}`)
      await mkdir(folder)
      await validatePortableArchive(source)
      await extractZip(source, folder, MAX_SKILL_SIZE)
      const directory = await resolveSkillDirectory(folder, null, null)
      await assertSkillDirectoryWithinLimits(directory)
      const staged = path.join(staging, item.id)
      await rename(directory, staged)
      packages.push({ ...item, directory: staged })
    }
    packages.sort((a, b) => Number(a.id === target.id) - Number(b.id === target.id))
    return await install(packages)
  } finally {
    await safeRemoveDirectory(temp)
  }
}
