import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseArguments, runEnterpriseBuild } from '../build-enterprise'

const projectRoot = path.join(import.meta.dirname, '..', '..')

describe('enterprise customer packaging', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it.each([
    ['pnpm forwards the separator', ['huali', '--', '--win', '--x64']],
    ['pnpm consumes the separator', ['huali', '--win', '--x64']]
  ])('accepts one customer, platform and architecture when %s', (_name, args) => {
    expect(parseArguments(args)).toEqual({
      company: 'huali',
      builderArgs: ['--win', '--x64']
    })
  })

  it.each([
    [[], 'Usage'],
    [['../huali', '--', '--win'], 'Usage'],
    [['huali', '--', '--win', '--mac'], 'exactly one platform'],
    [['huali', '--', '--win', '--x64', '--arm64'], 'at most one architecture']
  ])('rejects ambiguous or unsafe arguments: %j', (args, message) => {
    expect(() => parseArguments(args)).toThrow(message)
  })

  it('adds the customer identifier to every artifact name', async () => {
    vi.stubEnv('MEA_ENTERPRISE_COMPANY', 'huali')
    vi.resetModules()
    const { default: config } = await import('../../electron-builder.enterprise.config.cjs')

    expect(config.extends).toBe('./electron-builder.yml')
    for (const target of ['win', 'nsis', 'portable', 'mac', 'linux']) {
      expect(config[target].artifactName).toMatch(/^MEA-Cowork-Enterprise-huali-/)
    }
  })

  it('loads the selected environment for compilation and packaging', () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => ({ status: 0 }))

    expect(
      runEnterpriseBuild({
        projectRoot,
        company: 'example',
        builderArgs: ['--win', '--x64'],
        spawn
      })
    ).toBe(0)

    const prefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : []
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      [...prefix, 'run', 'typecheck'],
      [...prefix, 'exec', 'dotenv', '-e', path.join(projectRoot, '.env.example'), '--', 'electron-vite', 'build'],
      [...prefix, 'run', 'build:utility-process'],
      [
        ...prefix,
        'exec',
        'dotenv',
        '-e',
        path.join(projectRoot, '.env.example'),
        '--',
        'electron-builder',
        '--config',
        'electron-builder.enterprise.config.cjs',
        '--win',
        '--x64'
      ]
    ])
    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm')
      expect(call[2].env).toMatchObject({ CHERRY_EDITION: 'global', MEA_ENTERPRISE_COMPANY: 'example' })
      expect(call[2].shell).toBeUndefined()
    }
  })

  it('stops before compilation when typecheck fails', () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => ({ status: 7 }))

    expect(
      runEnterpriseBuild({
        projectRoot,
        company: 'example',
        builderArgs: ['--win', '--x64'],
        spawn
      })
    ).toBe(7)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
