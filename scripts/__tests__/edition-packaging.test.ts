import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { ProviderEdition } from '@cherrystudio/provider-registry'

import createChinaEditionConfig from '../../electron-builder.cn.config.cjs'
import { APP_EDITIONS, type AppEdition } from '../../src/shared/types/appEdition'
import {
  CHINA_EDITION,
  EDITIONS,
  getExpectedReleaseArtifacts,
  getReleaseChannel,
  GLOBAL_EDITION
} from '../release/edition'

const projectRoot = path.join(import.meta.dirname, '..', '..')
const packageMetadata = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

type WorkflowStep = {
  if?: string
  name?: string
  run?: string
  uses?: string
}

type GitCodeWorkflow = {
  jobs: {
    'build-windows-signed': {
      strategy?: { matrix?: { edition?: string[] } }
      steps: WorkflowStep[]
    }
    'sync-to-gitcode': { steps: WorkflowStep[] }
  }
}

describe('edition packaging', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('keeps application and release editions aligned with the registry contract', () => {
    expectTypeOf<AppEdition>().toEqualTypeOf<ProviderEdition>()
    expect(EDITIONS).toEqual(APP_EDITIONS)
  })

  it('injects the selected edition into the renderer build', async () => {
    vi.stubEnv('CHERRY_EDITION', CHINA_EDITION)
    vi.resetModules()
    const { default: electronViteConfig, resolveRendererEdition } = await import('../../electron.vite.config')
    const rendererDefine = (
      electronViteConfig as {
        renderer: { define: Record<string, string> }
      }
    ).renderer.define

    expect(resolveRendererEdition(undefined)).toBe(GLOBAL_EDITION)
    expect(resolveRendererEdition(' CN ')).toBe(CHINA_EDITION)
    expect(() => resolveRendererEdition('enterprise')).toThrow('Unsupported renderer edition: enterprise')
    expect(rendererDefine.__APP_EDITION__).toBe(JSON.stringify(CHINA_EDITION))
  })

  it('pins the renderer edition for build and preview entry points', () => {
    expect(packageMetadata.scripts.build).toContain('CHERRY_EDITION=global')
    expect(packageMetadata.scripts['build:cn']).toContain('CHERRY_EDITION=cn')
    expect(packageMetadata.scripts['start:cn']).toContain('CHERRY_EDITION=cn')
    expect(packageMetadata.scripts['start:cn']).toContain('pnpm start')
  })

  it('uses the China build entry point for every China package', () => {
    for (const scriptName of ['build:unpack:cn', 'build:win:cn', 'build:mac:cn', 'build:linux:cn']) {
      expect(packageMetadata.scripts[scriptName]).toContain('pnpm run build:cn')
    }
  })

  it.each([
    ['win', 'x64'],
    ['win', 'arm64'],
    ['mac', 'x64'],
    ['mac', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64']
  ])('provides a China edition %s %s package entry point', (platform, arch) => {
    const script = packageMetadata.scripts[`build:${platform}:${arch}:cn`]

    expect(script).toContain('pnpm run build:cn')
    expect(script).toContain('--config electron-builder.cn.config.cjs')
    expect(script).toContain(`--${platform}`)
    expect(script).toContain(`--${arch}`)
  })

  it('uses the independent MEA Cowork product and update identity', () => {
    const config = parse(readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8'))

    expect({
      appId: config.appId,
      edition: config.extraMetadata?.cherryEdition,
      nsisGuid: config.nsis.guid,
      productName: config.productName,
      protocol: config.protocols[0].schemes[0],
      publish: config.publish,
      windowsArtifactName: config.win.artifactName
    }).toEqual({
      appId: 'com.meacowork.enterprise',
      edition: GLOBAL_EDITION,
      nsisGuid: '652956ab-a934-4b3f-8318-2fda9a583666',
      productName: 'MEA Cowork 企业版',
      protocol: 'meacowork-enterprise',
      publish: null,
      windowsArtifactName: 'MEA-Cowork-Enterprise-${version}-win-${arch}-setup.${ext}'
    })
  })

  it('keeps English artifact and install names separate from the Chinese application name', () => {
    const config = parse(readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8'))
    const installer = readFileSync(path.join(projectRoot, config.nsis.include), 'utf8')

    expect(config.productName).toBe('MEA Cowork 企业版')
    expect(config.mac.executableName).toBe('MEACoworkEnterprise')
    expect(config.mac.extendInfo.CFBundleName).toBe('MEA Cowork 企业版')
    // Finder only localizes the bundle when its base display name matches the on-disk name.
    expect(config.mac.extendInfo.CFBundleDisplayName).toBe(config.mac.executableName)
    expect(config.mac.extendInfo.LSHasLocalizedDisplayName).toBe(true)
    expect(config.mac.extendInfo.CFBundleDevelopmentRegion).toBe('en')
    const localizedNames = config.mac.extraResources.find((resource: { from: string }) =>
      resource.from.endsWith('zh_CN.lproj')
    )
    expect(localizedNames.to).toBe('zh_CN.lproj')
    const strings = readFileSync(path.join(projectRoot, localizedNames.from, 'InfoPlist.strings'), 'utf8')
    expect(strings).toContain('CFBundleDisplayName = "MEA Cowork 企业版";')
    expect(strings).toContain('CFBundleName = "MEA Cowork 企业版";')
    const fallbackNames = config.mac.extraResources.find((resource: { from: string }) =>
      resource.from.endsWith('en.lproj')
    )
    expect(fallbackNames.to).toBe('en.lproj')
    expect(readFileSync(path.join(projectRoot, fallbackNames.from, 'InfoPlist.strings'), 'utf8')).toBe(strings)
    expect(config.nsis.shortcutName).toBe('${productName}')
    expect(config.nsis.uninstallDisplayName).toBe('${productName}')
    expect(installer).toContain('!define /redef APP_FILENAME "MEA-Cowork-Enterprise"')
    for (const target of ['win', 'nsis', 'portable', 'mac', 'linux']) {
      expect(config[target].artifactName).toMatch(/^MEA-Cowork-Enterprise-/)
    }
  })

  it('changes only the package identity, edition marker, and update channel for the China edition', async () => {
    const config = await createChinaEditionConfig({
      packageMetadata: { value: Promise.resolve({ version: '2.1.0' }) }
    })

    expect(config).toEqual({
      extends: './electron-builder.yml',
      appId: 'com.meacowork.enterprise.cn',
      extraMetadata: {
        cherryEdition: CHINA_EDITION
      },
      publish: null
    })
  })

  it('shares the global Electron application name used for userData', async () => {
    const config = await createChinaEditionConfig({
      packageMetadata: { value: Promise.resolve(packageMetadata) }
    })
    const chinaPackageMetadata = { ...packageMetadata, ...config.extraMetadata }

    expect(packageMetadata.productName ?? packageMetadata.name).toBe('meacowork-enterprise')
    expect(chinaPackageMetadata.productName ?? chinaPackageMetadata.name).toBe('meacowork-enterprise')
  })

  it.each([
    ['2.1.0', 'latest-enterprise', 'latest-enterprise-cn'],
    ['2.1.0-rc.1', 'rc-enterprise', 'rc-enterprise-cn'],
    ['2.1.0-beta.2', 'beta-enterprise', 'beta-enterprise-cn']
  ])('maps %s to separate global and China update channels', (version, globalChannel, chinaChannel) => {
    expect(getReleaseChannel(version, GLOBAL_EDITION)).toBe(globalChannel)
    expect(getReleaseChannel(version, CHINA_EDITION)).toBe(chinaChannel)
  })

  it('defines the complete China edition artifact contract', () => {
    expect(
      getExpectedReleaseArtifacts({
        edition: CHINA_EDITION,
        platform: 'linux',
        productName: 'MEA Cowork 企业版',
        version: '2.1.0-rc.1'
      })
    ).toEqual({
      files: [
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-x64.AppImage',
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-x64.deb',
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-x64.rpm',
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-arm64.AppImage',
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-arm64.deb',
        'MEA-Cowork-Enterprise-2.1.0-rc.1-linux-arm64.rpm'
      ],
      manifests: [
        {
          file: 'rc-enterprise-cn-linux.yml',
          urls: ['MEA-Cowork-Enterprise-2.1.0-rc.1-linux-x64.AppImage']
        },
        {
          file: 'rc-enterprise-cn-linux-arm64.yml',
          urls: ['MEA-Cowork-Enterprise-2.1.0-rc.1-linux-arm64.AppImage']
        }
      ]
    })
  })

  it('requires both macOS updater blockmaps', () => {
    expect(
      getExpectedReleaseArtifacts({
        edition: CHINA_EDITION,
        platform: 'mac',
        productName: 'MEA Cowork 企业版',
        version: '2.1.0'
      }).files
    ).toEqual([
      'MEA-Cowork-Enterprise-2.1.0-mac-x64.zip',
      'MEA-Cowork-Enterprise-2.1.0-mac-x64.zip.blockmap',
      'MEA-Cowork-Enterprise-2.1.0-mac-arm64.zip',
      'MEA-Cowork-Enterprise-2.1.0-mac-arm64.zip.blockmap',
      'MEA-Cowork-Enterprise-2.1.0-mac-x64.dmg',
      'MEA-Cowork-Enterprise-2.1.0-mac-arm64.dmg'
    ])
  })

  it('re-signs both Windows editions before syncing the release to GitCode', () => {
    const workflow = parse(
      readFileSync(path.join(projectRoot, '.github/workflows/sync-to-gitcode.yml'), 'utf8')
    ) as GitCodeWorkflow
    const buildJob = workflow.jobs['build-windows-signed']
    const syncJob = workflow.jobs['sync-to-gitcode']
    const buildStep = buildJob.steps.find((step) => step.name === 'Build Windows with code signing')
    const preserveStep = buildJob.steps.find((step) => step.name === 'Preserve signed Windows artifacts locally')

    expect(buildJob.strategy?.matrix?.edition).toEqual([GLOBAL_EDITION, CHINA_EDITION])
    expect(buildStep?.run).toMatch(/^\s*pnpm build:win:cn\s*$/m)
    expect(buildStep?.run).toMatch(/^\s*pnpm build:win\s*$/m)
    expect(buildStep?.run).toContain('electron-builder.cn.config.cjs')
    expect(preserveStep?.if).toContain('steps.build-windows.outputs.supported')
    expect(
      [...buildJob.steps, ...syncJob.steps].some((step) => /actions\/(upload|download)-artifact@/.test(step.uses ?? ''))
    ).toBe(false)
  })
})
