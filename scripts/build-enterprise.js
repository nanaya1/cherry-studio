const { existsSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const COMPANY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i
const SUPPORTED_PLATFORMS = new Set(['win', 'mac', 'linux'])
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])

function parseArguments(args) {
  const separator = args.indexOf('--')
  const company = args[0]
  const builderArgs = separator === -1 ? args.slice(1) : args.slice(separator + 1)
  const ownArgs = separator === -1 ? args.slice(0, 1) : args.slice(0, separator)

  if (!company || ownArgs.length !== 1 || !COMPANY_NAME_PATTERN.test(company)) {
    throw new Error('Usage: pnpm build:enterprise <company> -- --win|--mac|--linux [--x64|--arm64]')
  }

  const platforms = builderArgs.filter((argument) => SUPPORTED_PLATFORMS.has(argument.replace(/^--/, '')))
  const architectures = builderArgs.filter((argument) => SUPPORTED_ARCHITECTURES.has(argument.replace(/^--/, '')))
  if (platforms.length !== 1 || architectures.length > 1) {
    throw new Error('Pass exactly one platform and at most one architecture after --')
  }

  return { company, builderArgs }
}

function resolveEnvironmentFile(projectRoot, company) {
  const environmentFile = path.join(projectRoot, `.env.${company}`)
  if (!existsSync(environmentFile)) throw new Error(`Enterprise environment file not found: .env.${company}`)
  return environmentFile
}

function runEnterpriseBuild({ projectRoot, company, builderArgs, spawn = spawnSync }) {
  const environmentFile = resolveEnvironmentFile(projectRoot, company)
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm'
  const commandPrefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : []
  const environment = {
    ...process.env,
    CHERRY_EDITION: 'global',
    MEA_ENTERPRISE_COMPANY: company
  }

  const typecheck = spawn(command, [...commandPrefix, 'run', 'typecheck'], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  })
  if (typecheck.error) throw typecheck.error
  if (typecheck.status !== 0) return typecheck.status ?? 1

  const build = spawn(
    command,
    [...commandPrefix, 'exec', 'dotenv', '-e', environmentFile, '--', 'electron-vite', 'build'],
    {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit'
    }
  )
  if (build.error) throw build.error
  if (build.status !== 0) return build.status ?? 1

  const utilityBuild = spawn(command, [...commandPrefix, 'run', 'build:utility-process'], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  })
  if (utilityBuild.error) throw utilityBuild.error
  if (utilityBuild.status !== 0) return utilityBuild.status ?? 1

  const packageBuild = spawn(
    command,
    [
      ...commandPrefix,
      'exec',
      'dotenv',
      '-e',
      environmentFile,
      '--',
      'electron-builder',
      '--config',
      'electron-builder.enterprise.config.cjs',
      ...builderArgs
    ],
    {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit'
    }
  )
  if (packageBuild.error) throw packageBuild.error
  return packageBuild.status ?? 1
}

function main() {
  try {
    const { company, builderArgs } = parseArguments(process.argv.slice(2))
    process.exitCode = runEnterpriseBuild({ projectRoot: path.join(__dirname, '..'), company, builderArgs })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { parseArguments, resolveEnvironmentFile, runEnterpriseBuild }
