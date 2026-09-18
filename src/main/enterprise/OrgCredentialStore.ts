/**
 * [enterprise] T0 企业扩展 - 登录状态持久化（参考 CherryAccountCredentialStore）
 * JSON 文件存储，chmod 600。路径经 application.getPath 集中管理。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { application } from '@application'
import { loggerService } from '@logger'

const logger = loggerService.withContext('OrgCredentialStore')

// T0 复用 feature 路径机制：在技能库同级建 enterprise 私有目录存凭据
const credDir = join(application.getPath('feature.agents.skills'), '..', 'enterprise')
const credFile = join(credDir, 'org-session.json')

export const orgSessionSchema = z.object({
  userId: z.string(),
  phone: z.string(),
  role: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number()
})

export type OrgSession = z.infer<typeof orgSessionSchema>

const fileSchema = z.object({ session: orgSessionSchema.strict() })

export class OrgCredentialStore {
  load(): OrgSession | null {
    try {
      if (!existsSync(credFile)) return null
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(credFile, 'utf8')))
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
    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify({ session }, null, 2), { mode: 0o600 })
    chmodSync(credFile, 0o600)
  }

  clear() {
    try {
      if (existsSync(credFile)) rmSync(credFile)
    } catch (error) {
      logger.warn('failed to remove org session file', { error: String(error) })
    }
  }
}
