/**
 * [enterprise] T0 企业扩展 - 技能目录：企业下发 → hash 校验 → 复用 SkillService 安装
 * 生命周期事件上报（install/exec）走 OrgApiClient。
 */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loggerService } from '@logger'
import type { OrgSkillCatalogItem } from './types'

const execFileAsync = promisify(execFile)
const logger = loggerService.withContext('OrgSkillCatalog')

export class OrgSkillCatalog {
  constructor(private readonly auth: import('./OrgAuthManager').OrgAuthManager) {}

  async list(): Promise<OrgSkillCatalogItem[]> {
    const { skills } = await this.auth.apiClient.listSkills()
    return skills
  }

  /** 安装企业技能：下载（服务端校验）→ 解包 → SkillService.installSkillDir(source='org') → 上报 */
  async install(slug: string): Promise<void> {
    const catalog = await this.list()
    const item = catalog.find((s) => s.slug === slug)
    if (!item) throw new Error(`企业技能不存在: ${slug}`)

    const workDir = join(tmpdir(), `org-skill-${slug}-${Date.now()}`)
    const tarballPath = join(workDir, `${slug}.tar.gz`)
    const extractDir = join(workDir, 'extract')

    try {
      await mkdir(extractDir, { recursive: true })
      await this.downloadWithHash(item, tarballPath)
      await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir])

      // tarball 结构：<slug>/SKILL.md
      const skillDir = join(extractDir, slug)
      // [enterprise] 以 org 来源安装；同 folderName 且同来源时允许覆盖更新
      // SkillService 未进服务注册表，用导出单例 + 断言访问（installSkillDir 为私有）
      const { skillService } = await import('@main/ai/skills/SkillService')
      const installed = await (skillService as unknown as {
        installSkillDir: (dir: string, source: string, sourceUrl: string | null) => Promise<{ id?: string }>
      }).installSkillDir(skillDir, 'org', `org-skill:${slug}`)

      await this.auth.apiClient.reportLifecycle(slug, 'install', { version: item.version })
      logger.info('org skill installed', { slug, version: item.version, id: (installed as { id?: string }).id })
    } catch (error) {
      logger.error('org skill install failed', error as Error, { slug })
      throw error
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 技能执行上报（T0 埋点：AgentPage 触发技能时由渲染层调 IPC 上报） */
  reportExec(slug: string, detail: Record<string, unknown> = {}) {
    return this.auth.apiClient.reportLifecycle(slug, 'exec', detail)
  }

  /** 下载 + sha256 边下边校验，不匹配即抛错（复用 OrgApiClient 逻辑太绕，这里独立实现） */
  private async downloadWithHash(item: OrgSkillCatalogItem, destPath: string): Promise<void> {
    const session = await this.auth.getValidSession()
    if (!session) throw new Error('未登录企业服务')

    const res = await fetch(`${this.baseUrl()}${item.downloadUrl}`, {
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    if (!res.ok || !res.body) throw new Error(`技能包下载失败 (${res.status})`)

    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      hash.update(Buffer.from(value))
    }
    const actual = hash.digest('hex')
    if (actual !== item.contentHash) {
      throw new Error(`技能包校验失败：期望 ${item.contentHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
    await writeFile(destPath, Buffer.concat(chunks))
    // 防止未使用警告
    void createReadStream
  }

  private baseUrl() {
    // 与 OrgAuthManager 保持一致（T0 联调固定值）
    return 'http://127.0.0.1:3000'
  }
}
