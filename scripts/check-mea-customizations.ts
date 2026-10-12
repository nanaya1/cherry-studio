import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { parse } from 'yaml'

type Customization = {
  id: string
  title: string
  behavior: string
  touchpoints: string[]
  tests: string[]
  markers?: string[]
}

type Manifest = {
  version: number
  product: string
  customizations: Customization[]
}

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(root, '.mea/customizations.yml')
const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined

function fail(message: string): never {
  console.error(`[MEA] ${message}`)
  process.exit(1)
}

function exists(relativePath: string) {
  return fs.existsSync(path.join(root, relativePath))
}

function walkFiles(relativePath: string): string[] {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath)) return []
  if (fs.statSync(absolutePath).isFile()) return [absolutePath]
  return fs.readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relativePath, entry.name)
    return entry.isDirectory() ? walkFiles(child) : [path.join(root, child)]
  })
}

function markerExists(marker: string, touchpoints: string[]) {
  return touchpoints.some((touchpoint) =>
    walkFiles(touchpoint).some((file) => {
      try {
        return fs.readFileSync(file, 'utf8').includes(marker)
      } catch {
        return false
      }
    })
  )
}

if (!exists('.mea/customizations.yml')) fail('missing .mea/customizations.yml')

const manifest = parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
if (manifest.version !== 1) fail(`unsupported manifest version: ${manifest.version}`)
if (manifest.product !== 'MEACowork') fail(`unexpected product: ${manifest.product}`)
if (!Array.isArray(manifest.customizations) || manifest.customizations.length === 0) fail('no customizations registered')

const ids = new Set<string>()
for (const item of manifest.customizations) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) fail(`invalid customization id: ${item.id}`)
  if (ids.has(item.id)) fail(`duplicate customization id: ${item.id}`)
  ids.add(item.id)
  if (!item.title?.trim() || !item.behavior?.trim()) fail(`${item.id}: title and behavior are required`)
  if (!item.touchpoints?.length) fail(`${item.id}: at least one touchpoint is required`)
  if (!item.tests?.length) fail(`${item.id}: at least one focused test is required`)
  for (const touchpoint of item.touchpoints) {
    if (!exists(touchpoint)) fail(`${item.id}: missing touchpoint ${touchpoint}`)
  }
  for (const test of item.tests) {
    if (!exists(test)) fail(`${item.id}: missing test ${test}`)
  }
  for (const marker of item.markers ?? []) {
    if (!markerExists(marker, item.touchpoints)) fail(`${item.id}: marker ${marker} not found in its touchpoints`)
  }
}

console.log(`[MEA] contract valid: ${manifest.customizations.length} customizations`)

if (base) {
  let changedFiles: string[]
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', base], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    fail(`cannot diff base ${base}`)
  }

  const affected = manifest.customizations.filter((item) =>
    item.touchpoints.some((touchpoint) =>
      changedFiles.some((file) => file === touchpoint || file.startsWith(`${touchpoint.replace(/\/$/, '')}/`))
    )
  )

  console.log(`[MEA] changed files since ${base}: ${changedFiles.length}`)
  if (affected.length === 0) {
    console.log('[MEA] no registered customization touchpoints changed')
  } else {
    console.log('[MEA] mandatory semantic review:')
    for (const item of affected) {
      console.log(`- ${item.id}: ${item.title}`)
      for (const test of item.tests) console.log(`  test: ${test}`)
    }
  }
}
