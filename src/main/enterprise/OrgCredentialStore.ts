/**
 * [enterprise] T0 企业扩展 - 登录状态持久化（参考 CherryAccountCredentialStore）
 * JSON 文件存储，chmod 600。路径经 application.getPath 集中管理。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import * as z from 'zod'

import { application } from '@application'
import { loggerService } from '@logger'

import type { OrgSession } from './types'

const logger = loggerService.withContext('OrgCredentialStore')

// T0 复用 feature 路径机制：在技能库同级建 enterprise 私有目录存凭据。
// 必须延迟到调用时取路径——模块加载早于 application.initPathRegistry()，
// 顶层取值会在 Electron 启动时抛 "called before initPathRegistry" 并崩掉 App。
function credFile(): string {
  return join(application.getPath('feature.agents.skills'), '..', 'enterprise', 'org-session.json')
}

export const orgSessionSchema = z.object({
  // authMode: z.enum(['management-oauth', 'official-direct']).default('management-oauth'), // [enterprise] 旧多模式 schema 已删除
  authMode: z.literal('management-oauth'),
  authOrigin: z.string(),
  userId: z.string(),
  officialUserId: z.string(),
  displayName: z.string().nullable().default(null),
  phone: z.string(),
  role: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number()
})

export type { OrgSession }

const fileSchema = z.object({ session: orgSessionSchema.strict() })

export class OrgCredentialStore {
  load(): OrgSession | null {
    try {
      const filePath = credFile()
      if (!existsSync(filePath)) return null
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (!parsed.success) {
        logger.warn('org session file corrupted, ignoring')
        return null
      }

      return parsed.data.session
    } catch (error) {
      logger.warn('failed to read org session file', { error: String(error) })
      return null
    }
  }

  save(session: OrgSession) {
    const filePath = credFile()
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({ session }, null, 2), { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }

  clear() {
    try {
      const filePath = credFile()
      if (existsSync(filePath)) rmSync(filePath)
    } catch (error) {
      logger.warn('failed to remove org session file', { error: String(error) })
    }
  }
}
