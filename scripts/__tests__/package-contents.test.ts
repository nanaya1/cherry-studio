import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { getNativeModuleFilters } from '../before-pack'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher')
const config = parse(readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8')) as { files: string[] }
const fileStat = statSync(path.join(projectRoot, 'package.json'))

function includesFile(filename: string, patterns = config.files): boolean {
  return new FileMatcher(projectRoot, projectRoot, (value: string) => value, patterns).createFilter()(
    path.join(projectRoot, filename),
    fileStat
  )
}

describe('packaged dependency contents', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'arm64', 'linux-arm64-gnu'],
    ['linux', 'x64', 'linux-x64-gnu'],
    ['win32', 'arm64', 'win32-arm64-msvc'],
    ['win32', 'x64', 'win32-x64-msvc']
  ])('keeps only %s %s native payloads, including nested dependencies', (platform, arch, nativeBindingTarget) => {
    const patterns = [...config.files, ...getNativeModuleFilters(platform, arch)]
    for (const modules of ['node_modules', 'node_modules/consumer/node_modules']) {
      for (const targetPlatform of ['darwin', 'linux', 'win32']) {
        for (const targetArch of ['arm64', 'x64']) {
          const target = `${targetPlatform}-${targetArch}`
          const keep = targetPlatform === platform && targetArch === arch
          for (const file of [
            `@koromix/koffi-${target}/koffi.node`,
            `node-pty/prebuilds/${target}/pty.node`,
            `selection-hook/prebuilds/${target}/selection.node`,
            `@anthropic-ai/claude-agent-sdk-${target}/claude`
          ]) {
            expect(includesFile(`${modules}/${file}`, patterns), file).toBe(keep)
          }
        }
      }
      for (const target of [
        'darwin-arm64',
        'darwin-x64',
        'darwin-universal',
        'linux-arm64-gnu',
        'linux-x64-gnu',
        'linux-x64-musl',
        'win32-arm64-msvc',
        'win32-x64-msvc'
      ]) {
        const file = `${modules}/@mariozechner/clipboard-${target}/clipboard.node`
        expect(includesFile(file, patterns), file).toBe(target === nativeBindingTarget)
      }
      for (const target of [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64-gnu',
        'linux-x64-gnu',
        'win32-arm64-msvc',
        'win32-ia32-msvc',
        'win32-x64-msvc'
      ]) {
        const file = `${modules}/node-addon-require-builtin-${target}/package.json`
        expect(includesFile(file, patterns), file).toBe(target === nativeBindingTarget)
      }
    }
  })

  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64']
  ])('excludes unsupported native variants from %s %s without dropping target binaries', (platform, arch) => {
    const patterns = [...config.files, ...getNativeModuleFilters(platform, arch)]
    const foreignPackages = [
      '@napi-rs/canvas-android-arm64',
      '@napi-rs/canvas-linux-arm-gnueabihf',
      '@napi-rs/canvas-linux-riscv64-gnu',
      '@img/sharp-libvips-linux-arm',
      '@img/sharp-libvips-linux-ppc64',
      '@img/sharp-libvips-linux-riscv64',
      '@img/sharp-libvips-linux-s390x',
      '@img/sharp-linux-arm',
      '@img/sharp-linux-ppc64',
      '@img/sharp-linux-riscv64',
      '@img/sharp-linux-s390x',
      '@img/sharp-win32-ia32',
      '@node-rs/xxhash-android-arm64',
      '@node-rs/xxhash-android-arm-eabi',
      '@node-rs/xxhash-linux-arm-gnueabihf',
      '@node-rs/xxhash-freebsd-x64',
      '@node-rs/xxhash-win32-ia32-msvc',
      'node-screenshots-linux-loong64-gnu'
    ]
    for (const modules of ['node_modules', 'node_modules/consumer/node_modules']) {
      for (const name of foreignPackages) {
        expect(includesFile(`${modules}/${name}/binding.node`, patterns), name).toBe(false)
      }
      const suffix = platform === 'darwin' ? '' : platform === 'win32' ? '-msvc' : '-gnu'
      for (const name of [
        `@napi-rs/canvas-${platform}-${arch}${suffix}`,
        `@img/sharp-${platform}-${arch}`,
        `@node-rs/xxhash-${platform}-${arch}${suffix}`,
        `node-screenshots-${platform}-${arch}${suffix}`
      ]) {
        expect(includesFile(`${modules}/${name}/binding.node`, patterns), name).toBe(true)
      }
      if (platform !== 'win32') {
        expect(includesFile(`${modules}/@img/sharp-libvips-${platform}-${arch}/lib/libvips.dylib`, patterns)).toBe(true)
      }
      if (platform === 'linux') {
        for (const name of [
          `@img/sharp-libvips-linuxmusl-${arch}`,
          `@napi-rs/canvas-linux-${arch}-musl`,
          `@node-rs/xxhash-linux-${arch}-musl`
        ]) {
          expect(includesFile(`${modules}/${name}/binding.node`, patterns), name).toBe(true)
        }
      }
      // WASM fallbacks are platform-neutral; native platform pruning must not remove them.
      expect(includesFile(`${modules}/@img/sharp-wasm32/lib/sharp.wasm`, patterns)).toBe(true)
      expect(includesFile(`${modules}/@node-rs/xxhash-wasm32-wasi/xxhash.wasm`, patterns)).toBe(true)
    }
  })

  it.each(['node_modules', 'node_modules/consumer/node_modules'])(
    'excludes SQLite build inputs and cached binaries under %s while preserving its runtime',
    (modules) => {
      const root = `${modules}/better-sqlite3`
      for (const file of [
        'deps/sqlite3/sqlite3.c',
        'build/Release/obj/gen/sqlite3/sqlite3.c',
        'bin/darwin-x64-149/better-sqlite3.node',
        'src/better_sqlite3.cpp'
      ]) {
        expect(includesFile(`${root}/${file}`), file).toBe(false)
      }
      for (const file of ['package.json', 'lib/database.js', 'build/Release/better_sqlite3.node']) {
        expect(includesFile(`${root}/${file}`), file).toBe(true)
      }
    }
  )

  it('excludes rebuild backups while preserving the SQLite runtime in nested dependencies', () => {
    for (const modules of ['node_modules', 'node_modules/consumer/node_modules']) {
      for (const file of ['Release/better_sqlite3.node', 'Release/obj/gen/sqlite3/sqlite3.c', 'config.gypi']) {
        expect(includesFile(`${modules}/better-sqlite3/build-electron-backup/${file}`), file).toBe(false)
      }
      expect(includesFile(`${modules}/better-sqlite3/build/Release/better_sqlite3.node`)).toBe(true)
    }
  })

  it('ships migrations only through extraResources, including the migration journal', () => {
    expect(includesFile('migrations/sqlite-drizzle/meta/0000_snapshot.json')).toBe(false)
    expect(includesFile('migrations/sqlite-drizzle/0000_initial.sql')).toBe(false)
    const { extraResources } = parse(readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8'))
    const resource = extraResources.find((entry: { from: string }) => entry.from === 'migrations/sqlite-drizzle')
    expect(resource).toEqual({ from: 'migrations/sqlite-drizzle', to: 'migrations/sqlite-drizzle' })
    const filter = new FileMatcher(
      path.join(projectRoot, resource.from),
      projectRoot,
      (value: string) => value,
      resource.filter ?? ['**/*']
    ).createFilter()
    for (const file of ['0000_initial.sql', 'meta/_journal.json', 'meta/0000_snapshot.json']) {
      expect(filter(path.join(projectRoot, resource.from, file), fileStat), file).toBe(true)
    }
  })

  it('keeps the Feishu CommonJS entry without shipping the unused ESM copy', () => {
    const sdk = JSON.parse(
      readFileSync(path.join(projectRoot, 'node_modules/@larksuiteoapi/node-sdk/package.json'), 'utf8')
    )
    for (const modules of ['node_modules', 'node_modules/consumer/node_modules']) {
      expect(includesFile(`${modules}/@larksuiteoapi/node-sdk/es/index.js`)).toBe(false)
      expect(includesFile(`${modules}/@larksuiteoapi/node-sdk/${sdk.main.replace(/^\.\//, '')}`)).toBe(true)
      expect(includesFile(`${modules}/@larksuiteoapi/node-sdk/package.json`)).toBe(true)
    }
  })

  it('excludes dependency documentation images without removing runtime assets or source JS', () => {
    for (const file of [
      'node_modules/selection-hook/docs/images/selection-hook.gif',
      'node_modules/@earendil-works/pi-coding-agent/docs/images/exy.png'
    ]) {
      expect(includesFile(file), file).toBe(false)
    }
    for (const file of [
      'node_modules/koffi/src/koffi/index.cjs',
      'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/assets/cherry_acl.ps1',
      'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/assets/SKILL.md',
      'node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap',
      'resources/builtin-agents/icon.png'
    ]) {
      expect(includesFile(file), file).toBe(true)
    }
  })
})
