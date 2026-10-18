import { open, readFile } from 'node:fs/promises'
import path from 'node:path'

import { type ZodType } from 'zod'

import { atomicWriteFile } from '@main/utils/file'
import { AbsoluteFilePathSchema } from '@shared/types/file'

export type ControlReadResult<T> =
  | { kind: 'none' }
  | { kind: 'corrupt'; filePath: string; error: string }
  | { kind: 'ok'; value: T }

export type ControlWriteResult =
  | { kind: 'committed-confirmed' }
  | { kind: 'committed-durability-unknown'; reason: 'unsupported' | 'error'; error: string }

export type ControlMutationResult<T> = {
  value: T
  durability: ControlWriteResult | { kind: 'not-written' }
}

export type DurabilityConfirmer = (filePath: string) => Promise<void>

const unsupportedCodes = new Set(['EINVAL', 'EISDIR', 'ENOTSUP'])

export function isUnsupportedParentDirectoryDurabilityError(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (code !== undefined && unsupportedCodes.has(code)) return true
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES')
}

async function confirmParentDirectoryDurability(filePath: string): Promise<void> {
  const directory = await open(path.dirname(filePath), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export class ProfileControlStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly confirmDurability: DurabilityConfirmer = confirmParentDirectoryDurability
  ) {}

  get path(): string {
    return this.filePath
  }

  async read(): Promise<ControlReadResult<T>> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'none' }
      }
      throw error
    }

    try {
      return { kind: 'ok', value: this.schema.parse(JSON.parse(content)) }
    } catch (error) {
      return {
        kind: 'corrupt',
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async write(value: T): Promise<ControlWriteResult> {
    const validated = this.schema.parse(value)
    const content = `${JSON.stringify(validated, null, 2)}\n`
    await atomicWriteFile(AbsoluteFilePathSchema.parse(this.filePath), content, { mode: 0o600 })

    // Control-plane callers need to distinguish a committed rename from confirmed directory durability.
    try {
      await this.confirmDurability(this.filePath)
      return { kind: 'committed-confirmed' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const unsupported = isUnsupportedParentDirectoryDurabilityError(code)
      return {
        kind: 'committed-durability-unknown',
        reason: unsupported ? 'unsupported' : 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
