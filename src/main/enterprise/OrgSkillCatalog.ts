/**
 * [enterprise] T0 企业扩展 - 技能目录：企业下发 → hash 校验 → 复用 SkillService 安装
 * 生命周期事件上报（install/exec）走 OrgApiClient。
 * C1/C2/C4 扩展：启动扫描自动更新、停用拦截（TTL 缓存）、删除上报、状态记录（OrgStateStore）。
 */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loggerService } from '@logger'
import { orgStateStore } from './OrgStateStore'
import type { OrgSkillCatalogItem } from './types'

const execFileAsync = promisify(execFile)
const logger = loggerService.withContext('OrgSkillCatalog')

/** C2 目录缓存 TTL：企业停用技能后最多 5 分钟生效到"不注入新会话" */
const CATALOG_TTL_MS = 5 * 60 * 1000

export class OrgSkillCatalog {
  // [enterprise] C2 目录缓存：{ at, items, failed }
  private catalogCache: { at: number; items: OrgSkillCatalogItem[] } | null = null

  // [enterprise] 测试可注入点（生产恒为 promisify(execFile)）
  protected tarExtract: typeof execFileAsync = execFileAsync

  constructor(private readonly auth: import('./OrgAuthManager').OrgAuthManager) {}

  async list(): Promise<OrgSkillCatalogItem[]> {
    // [enterprise] C2：走 5 分钟 TTL 缓存；失败时若有过期缓存则降级使用（可用性优先）
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.items
    }
    try {
      const { skills } = await this.auth.apiClient.listSkills()
      this.catalogCache = { at: Date.now(), items: skills }
      return skills
    } catch (error) {
      if (this.catalogCache) {
        logger.warn('org skill catalog fetch failed, using stale cache', { error: String(error) })
        return this.catalogCache.items
      }
      throw error
    }
  }

  /**
   * [enterprise] C2 停用拦截查询：返回当前已停用/已下架的 org 技能 slug 列表。
   * 渲染层在构建新会话技能注入时调用，命中者不注入。
   * 目录不可达时抛错由调用方决定放行策略（fail-open）。
   */
  async listDisabled(): Promise<string[]> {
    const catalog = await this.list()
    const active = new Set(catalog.map((s) => s.slug))
    return Object.entries(orgStateStore.snapshot())
      .filter(([slug, state]) => !active.has(slug) || !state.enabled)
      .map(([slug]) => slug)
  }

  /**
   * [enterprise] C1 启动扫描：对比本地 state 与服务端目录 contentHash，
   * 不一致者静默重装（SkillService 同 origin 覆盖更新）；目录缺失者标记停用（C2）。
   * 供 EnterprisePlugin.onInit 调用；任何单项失败不阻塞其余项。
   */
  async startupScan(): Promise<{ updated: string[]; disabled: string[] }> {
    const updated: string[] = []
    const disabled: string[] = []
    let catalog: OrgSkillCatalogItem[]
    try {
      catalog = await this.list()
    } catch (error) {
      logger.warn('startupScan skipped: catalog unreachable', { error: String(error) })
      return { updated, disabled }
    }

    const remote = new Map(catalog.map((s) => [s.slug, s]))
    const local = orgStateStore.snapshot()

    // C1：远端有 & hash 变化 → 重装。
    // [enterprise] C4 防复活：有删除墓碑且 hash 与远端一致 → 用户明确删过，跳过；
    // hash 不一致（企业推了新版）→ 用户删除意图失效，清墓碑重新下发。
    for (const [slug, item] of remote) {
      const state = local[slug]
      const tombstoneHash = orgStateStore.deletedHash(slug)
      if (!state && tombstoneHash !== undefined) {
        if (tombstoneHash === item.contentHash) continue
        orgStateStore.clearDeleted(slug)
      }
      if (state && state.contentHash === item.contentHash) continue
      try {
        await this.downloadAndInstall(slug, item)
        updated.push(slug)
      } catch (error) {
        logger.warn('startupScan auto-update failed', { slug, error: String(error) })
      }
    }

    // C2：本地有 & 远端没有 → 标记停用（保留文件，提示"可删除"）
    for (const slug of Object.keys(local)) {
      if (!remote.has(slug)) {
        orgStateStore.setEnabled(slug, false)
        disabled.push(slug)
      } else {
        // [enterprise] C2：远端还在 → 恢复启用标记（上轮可能被误停）
        const state = local[slug]
        if (state && !state.enabled) orgStateStore.setEnabled(slug, true)
      }
    }

    if (updated.length || disabled.length) {
      logger.info('startupScan done', { updated, disabled })
    }
    return { updated, disabled }
  }

  /** 安装企业技能：下载（服务端校验）→ 解包 → SkillService.installSkillDir(source='org') → 上报 */
  async install(slug: string): Promise<void> {
    // [enterprise] C1：install 复用 downloadAndInstall（含 state 记录 + install 上报）
    await this.downloadAndInstall(slug)
  }

  /** [enterprise] 已安装的 org 技能 slug 列表（供目录对话框标记「已安装」状态）；删除墓碑（C4）不算已安装 */
  installedSlugs(): string[] {
    return Object.keys(orgStateStore.snapshot()).filter((slug) => orgStateStore.deletedHash(slug) === undefined)
  }

  /**
   * [enterprise] C1 下载 + 安装 + state 记录 + install 上报（install 与 startupScan 共用）。
   */
  private async downloadAndInstall(slug: string, knownItem?: OrgSkillCatalogItem): Promise<void> {
    const item = knownItem ?? (await this.list()).find((s) => s.slug === slug)
    if (!item) throw new Error(`企业技能不存在: ${slug}`)

    const workDir = join(tmpdir(), `org-skill-${slug}-${Date.now()}`)
    const tarballPath = join(workDir, `${slug}.tar.gz`)
    const extractDir = join(workDir, 'extract')

    try {
      await mkdir(extractDir, { recursive: true })
      await this.downloadWithHash(item, tarballPath)
      await this.tarExtract('tar', ['-xzf', tarballPath, '-C', extractDir])

      // tarball 结构：<slug>/SKILL.md
      const skillDir = join(extractDir, slug)
      // [enterprise] 以 org 来源安装；同 folderName 且同来源时允许覆盖更新
      // SkillService 未进服务注册表，用导出单例 + 断言访问（installSkillDir 为私有）
      const { skillService } = await import('@main/ai/skills/SkillService')
      const installed = await (skillService as unknown as {
        installSkillDir: (dir: string, source: string, sourceUrl: string | null) => Promise<{ id?: string; folderName?: string }>
      }).installSkillDir(skillDir, 'org', `org-skill:${slug}`)

      // [enterprise] C5：state 记录安装快照（version/contentHash/skillId/folderName）
      orgStateStore.upsert(slug, {
        version: item.version,
        contentHash: item.contentHash,
        skillId: String(installed.id ?? ''),
        folderName: installed.folderName ?? slug
      })

      // [enterprise] C4 闭环：重新安装 = 用户删除意图失效（语义与 startupScan 的「hash 变化清墓碑」一致），
      // 不清墓碑则 installedSlugs 永远排除该技能 → 组织 tab 永远显示可点的「安装」
      orgStateStore.clearDeleted(slug)

      await this.auth.apiClient.reportLifecycle(slug, 'install', { version: item.version })
      logger.info('org skill installed', { slug, version: item.version, id: (installed as { id?: string }).id })
    } catch (error) {
      logger.error('org skill install failed', error as Error, { slug })
      throw error
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * [enterprise] C4 删除上报：用户卸载 org 技能时调用（由 skill.uninstall IPC 拦截层触发）。
   * 上报失败不阻塞本地卸载；state 记录同步清除，并写入删除墓碑（slug → 删除时 hash），
   * 供 startupScan C1 防复活：同 hash 不自动重装，企业推新版（hash 变化）时清墓碑重装。
   */
  async reportDeleted(slug: string): Promise<void> {
    try {
      await this.auth.apiClient.reportLifecycle(slug, 'deleted', { slug })
    } finally {
      // [enterprise] 墓碑取删除时的 hash；安装记录已被卸载链路删除也要兜底清掉
      const deletedHash = orgStateStore.get(slug)?.contentHash
      if (deletedHash) orgStateStore.markDeleted(slug, deletedHash)
      orgStateStore.remove(slug)
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
